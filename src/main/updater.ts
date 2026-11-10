import electron from 'electron'
import updaterModule from 'electron-updater'
import type { AppUpdater, NsisUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import type { UpdateState, UpdateStatus } from '@shared/types'
import type { UpdateController } from './app'

const { app, net } = electron
const run = promisify(execFile)

/** Where releases are published (matches `publish` in electron-builder.yml). */
const RELEASES = { owner: 'ketiyohannes', repo: 'mint' } as const
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
/** macOS download: give up when no data arrives for this long. */
const DOWNLOAD_STALL_MS = 60_000

/**
 * Puts the new app bundle in place once mint has exited, then relaunches it.
 * Runs detached from mint: $1 pid to wait for, $2 where the app goes (the
 * installed bundle, or a new one in Applications), $3 verified new bundle,
 * $4 relaunch (1/0). A failed swap puts the old bundle back.
 */
const MAC_SWAP_SCRIPT = `
pid="$1"; target="$2"; staged="$3"; relaunch="$4"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 600 ] && exit 1
  sleep 0.2
done
if [ -e "$target" ]; then
  backup="$target.previous-$$"
  if mv "$target" "$backup"; then
    if mv "$staged" "$target"; then rm -rf "$backup"; else mv "$backup" "$target"; fi
  fi
else
  mkdir -p "$(dirname "$target")" && mv "$staged" "$target"
fi
[ "$relaunch" = 1 ] && open -n "$target"
exit 0
`

/**
 * The same swap where mint may not write (an app installed by another
 * account): macOS asks for an administrator's password, the swap runs as
 * root, and mint relaunches as the learner. $5 is MAC_SWAP_SCRIPT.
 */
const MAC_ADMIN_SWAP_SCRIPT = `
pid="$1"; target="$2"; staged="$3"; relaunch="$4"; swap="$5"
/usr/bin/osascript \
  -e 'on run argv' \
  -e 'do shell script "/bin/sh -c " & quoted form of item 1 of argv & " mint-update " & quoted form of item 2 of argv & " " & quoted form of item 3 of argv & " " & quoted form of item 4 of argv & " 0" with prompt "mint needs an administrator to install its update." with administrator privileges' \
  -e 'end run' "$swap" "$pid" "$target" "$staged"
[ "$relaunch" = 1 ] && open -n "$target"
exit 0
`

/** Linux, when mint is neither an AppImage nor a package: updates install as an AppImage here. */
const LINUX_APPIMAGE = join(homedir(), 'Applications', 'mint.AppImage')

/** Where the new macOS bundle goes, and whether that needs an administrator. */
interface MacPlan {
  target: string
  admin: boolean
}

export interface UpdaterOptions {
  /** Why updates are off (development or test builds); undefined when they are on. */
  disabledReason?: string
  emit(status: UpdateStatus): void
  log(message: string): void
  /**
   * A generic update feed (a URL serving latest-*.yml and the artifacts) used
   * instead of GitHub, for trying an update end to end before releasing it.
   */
  feedUrl?: string
  /** macOS: the Applications folder a copy run from the disk image installs into (for trying that path without touching the real one). */
  applicationsDir?: string
}

/**
 * Checks GitHub releases for a newer mint, downloads it on request and
 * installs it on restart, inside the app on every platform, wherever mint
 * was installed or run from.
 *
 * Windows and Linux use electron-updater end to end. On Windows, a copy
 * unzipped by hand is updated in place by running the installer into its
 * folder. On Linux, a copy that is neither an AppImage nor a package is
 * replaced by the AppImage in ~/Applications.
 *
 * macOS builds are ad-hoc signed, which Squirrel.Mac rejects, so there
 * electron-updater only reads the release feed: mint downloads the zip itself,
 * checks its SHA-512, signature and version, and a small script swaps the
 * bundle after mint quits. A copy run from the disk image or straight from
 * Downloads installs into Applications; one mint may not write asks for an
 * administrator's password.
 */
export class Updater implements UpdateController {
  private state: UpdateState
  private info: UpdateInfo | null = null
  /** macOS: the verified new bundle, waiting to replace the installed one. */
  private staged: string | null = null
  private macPlan: MacPlan | null = null
  private swapping = false
  /** A check is in flight (a background one does not show as the `checking` state). */
  private checking = false
  private timers: NodeJS.Timeout[] = []
  private readonly updater: AppUpdater | null

  constructor(private readonly opts: UpdaterOptions) {
    if (opts.disabledReason) {
      this.state = { status: 'disabled', reason: opts.disabledReason }
      this.updater = null
      return
    }
    this.state = { status: 'idle' }
    this.updater = updaterModule.autoUpdater
    const u = this.updater
    u.autoDownload = false
    // Windows and Linux apply a downloaded update when mint quits; macOS does the same in applyOnQuit().
    u.autoInstallOnAppQuit = true
    u.allowDowngrade = false
    u.logger = { info: (m) => opts.log(`update: ${m}`), warn: (m) => opts.log(`update: ${m}`), error: (m) => opts.log(`update error: ${m}`), debug: () => undefined }
    if (opts.feedUrl) u.setFeedURL({ provider: 'generic', url: opts.feedUrl })
    // electron-updater only updates an AppImage it was started from; anything else becomes the AppImage in ~/Applications.
    if (process.platform === 'linux' && !process.env.APPIMAGE && !existsSync(join(process.resourcesPath, 'package-type'))) process.env.APPIMAGE = LINUX_APPIMAGE
    u.on('download-progress', (p: ProgressInfo) => this.progress(p.percent))
    if (process.platform === 'darwin') void rm(this.stagingDir(), { recursive: true, force: true }).catch(() => undefined)
  }

  /** Check shortly after launch, then every few hours. */
  start(): void {
    if (!this.updater) return
    const quietCheck = () => {
      if (['idle', 'current', 'error', 'available'].includes(this.state.status)) void this.runCheck(true)
    }
    this.timers.push(setTimeout(quietCheck, FIRST_CHECK_MS), setInterval(quietCheck, CHECK_EVERY_MS))
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  status = async (): Promise<UpdateStatus> => this.snapshot()

  check = (): Promise<UpdateStatus> => this.runCheck(false)

  /**
   * `background`: the timer's own check. While an update is on offer it runs
   * out of sight, and a failure (offline, GitHub down) leaves that offer up
   * instead of replacing it with an error.
   */
  private async runCheck(background: boolean): Promise<UpdateStatus> {
    const u = this.updater
    if (!u || this.checking || this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'ready') return this.snapshot()
    const offered = background && this.state.status === 'available' ? this.state : null
    this.checking = true
    if (!offered) this.set({ status: 'checking' })
    try {
      const result = await u.checkForUpdates()
      // The learner started the download while this ran: that owns the state now.
      if (offered && this.state !== offered) return this.snapshot()
      if (!result?.isUpdateAvailable) {
        this.info = null
        this.set({ status: 'current', checkedAt: new Date().toISOString() })
      } else {
        this.info = result.updateInfo
        const version = result.updateInfo.version
        this.set({ status: 'available', version, notes: releaseNotes(result.updateInfo) })
      }
    } catch (err) {
      if (offered) this.opts.log(`update: background check failed: ${err instanceof Error ? err.message : String(err)}`)
      else this.fail(err)
    } finally {
      this.checking = false
    }
    return this.snapshot()
  }

  download = async (): Promise<UpdateStatus> => {
    const u = this.updater
    const info = this.info
    if (!u || !info || this.state.status !== 'available') return this.snapshot()
    const { version, notes } = this.state
    this.set({ status: 'downloading', version, percent: 0 })
    try {
      if (process.platform === 'darwin') {
        this.macPlan = await planMac(this.opts.applicationsDir ? [this.opts.applicationsDir] : ['/Applications', join(homedir(), 'Applications')])
        this.staged = await this.downloadMac(info)
      } else {
        if (process.platform === 'win32') await this.planWindows(u as NsisUpdater)
        await u.downloadUpdate()
      }
      this.set({ status: 'ready', version, notes })
    } catch (err) {
      this.fail(err)
    }
    return this.snapshot()
  }

  install = async (): Promise<void> => {
    if (this.state.status !== 'ready') return
    // Let the IPC reply reach the window before mint quits.
    setImmediate(() => {
      if (process.platform === 'darwin') {
        this.swapMac(true)
        app.quit()
      } else {
        if (process.env.APPIMAGE === LINUX_APPIMAGE) {
          // If the AppImage cannot be put in place, say so and stay open rather than quit into nothing.
          void this.prepareLinuxAppImage().then(
            () => this.updater?.quitAndInstall(true, true),
            (err) => this.fail(err)
          )
        } else this.updater?.quitAndInstall(true, true)
      }
    })
  }

  /** macOS: an update downloaded but not yet installed is applied when mint quits. */
  applyOnQuit(): void {
    // No password prompt while quitting: an update that needs an administrator waits for Restart to update.
    if (process.platform === 'darwin' && this.state.status === 'ready' && !this.macPlan?.admin) this.swapMac(false)
  }

  // -- internals -------------------------------------------------------------

  private snapshot(): UpdateStatus {
    return { currentVersion: app.getVersion(), state: this.state }
  }

  private set(state: UpdateState): void {
    this.state = state
    this.opts.emit(this.snapshot())
  }

  private progress(percent: number): void {
    if (this.state.status !== 'downloading') return
    const rounded = Math.max(0, Math.min(100, Math.floor(percent)))
    if (rounded !== this.state.percent) this.set({ ...this.state, percent: rounded })
  }

  private fail(err: unknown): void {
    const raw = err instanceof Error ? err.message : String(err)
    this.opts.log(`update failed: ${raw}`)
    this.set({ status: 'error', message: friendlyError(raw) })
  }

  /**
   * The zip build has no uninstaller. The installer then installs into its
   * folder, so this copy becomes the new version (rather than a second copy
   * elsewhere); a folder mint may not write gets the usual per-user install.
   */
  private async planWindows(u: NsisUpdater): Promise<void> {
    const folder = dirname(app.getPath('exe'))
    if (!existsSync(join(folder, 'Uninstall mint.exe')) && (await writable(folder))) u.installDirectory = folder
  }

  /** The AppImage electron-updater replaces must exist, even on the first install there. */
  private async prepareLinuxAppImage(): Promise<void> {
    await mkdir(dirname(LINUX_APPIMAGE), { recursive: true })
    if (!existsSync(LINUX_APPIMAGE)) await writeFile(LINUX_APPIMAGE, '')
  }

  private stagingDir(): string {
    return join(app.getPath('userData'), 'updates')
  }

  /** Download the new version's zip, verify it, and unpack it next to the user data. Returns the new bundle. */
  private async downloadMac(info: UpdateInfo): Promise<string> {
    const file = macZip(info)
    if (!file) throw new Error('This release has no build for this Mac.')
    const dir = this.stagingDir()
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })

    const url = /^https?:\/\//i.test(file.url)
      ? file.url
      : this.opts.feedUrl
        ? new URL(file.url, this.opts.feedUrl.replace(/\/?$/, '/')).toString()
        : `https://github.com/${RELEASES.owner}/${RELEASES.repo}/releases/download/v${info.version}/${encodeURIComponent(file.url)}`
    // A connection that goes quiet is dropped, so the download fails instead of sitting at a percentage forever.
    const stalled = new AbortController()
    let stallTimer = setTimeout(() => stalled.abort(), DOWNLOAD_STALL_MS)
    const alive = (): void => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => stalled.abort(), DOWNLOAD_STALL_MS)
    }

    const zip = join(dir, 'update.zip')
    const hash = createHash('sha512')
    try {
      const res = await net.fetch(url, { signal: stalled.signal })
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`)
      const total = Number(res.headers.get('content-length')) || file.size || 0
      let received = 0
      const progress = (bytes: number): void => {
        received += bytes
        if (total) this.progress((received / total) * 100)
      }
      // pipeline ends every stream on the first error (a full disk, a dropped connection) and rejects with it.
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        async function* (chunks: AsyncIterable<Uint8Array>) {
          for await (const chunk of chunks) {
            alive()
            hash.update(chunk)
            progress(chunk.byteLength)
            yield chunk
          }
        },
        createWriteStream(zip)
      )
    } catch (err) {
      if (stalled.signal.aborted) throw new Error('The download stopped receiving data. Check your connection and try again.')
      throw err
    } finally {
      clearTimeout(stallTimer)
    }
    if (hash.digest('base64') !== file.sha512) throw new Error('The download did not match the release checksum.')

    const unpacked = join(dir, 'unpacked')
    await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked])
    await rm(zip, { force: true })
    const bundle = join(unpacked, 'mint.app')
    const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')])
    if (stdout.trim() !== info.version) throw new Error(`The download is version ${stdout.trim()}, expected ${info.version}.`)
    // Ad-hoc signed: this checks the bundle is intact, not who made it (the checksum above covers that).
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', bundle]).catch(() => undefined)
    return bundle
  }

  private swapMac(relaunch: boolean): void {
    const plan = this.macPlan
    if (this.swapping || !this.staged || !plan) return
    this.swapping = true
    this.opts.log(`update: installing ${plan.target} on exit${plan.admin ? ' as an administrator' : ''}${relaunch ? ' and relaunching' : ''}`)
    const args = [String(process.pid), plan.target, this.staged, relaunch ? '1' : '0']
    const script = plan.admin ? [MAC_ADMIN_SWAP_SCRIPT, 'mint-update', ...args, MAC_SWAP_SCRIPT] : [MAC_SWAP_SCRIPT, 'mint-update', ...args]
    spawn('/bin/sh', ['-c', ...script], { detached: true, stdio: 'ignore' }).unref()
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Where the new bundle goes. An installed copy is replaced where it is. One
 * run from the disk image (read-only) or straight from Downloads (App
 * Translocation runs it from a random read-only path) has nothing to replace,
 * so the update installs into /Applications, or ~/Applications when mint may
 * not write there (`appDirs`, in order), and opens that copy.
 */
async function planMac(appDirs: string[]): Promise<MacPlan> {
  const bundle = macBundle()
  if (!bundle) throw new Error('mint is not running from an app bundle, so it cannot update itself.')
  const translocated = bundle.includes('/AppTranslocation/')
  if (!translocated && (await writable(bundle)) && (await writable(dirname(bundle)))) return { target: bundle, admin: false }
  if (!translocated && !bundle.startsWith('/Volumes/')) return { target: bundle, admin: true }
  for (const dir of appDirs) {
    if (dir.startsWith(homedir())) await mkdir(dir, { recursive: true }).catch(() => undefined)
    const target = join(dir, 'mint.app')
    if ((await writable(dir)) && (!existsSync(target) || (await writable(target)))) return { target, admin: false }
  }
  return { target: join(appDirs[0], 'mint.app'), admin: true }
}

/** The installed mint.app (…/mint.app/Contents/MacOS/mint → …/mint.app). */
function macBundle(): string | null {
  const bundle = resolve(app.getPath('exe'), '..', '..', '..')
  return bundle.endsWith('.app') ? bundle : null
}

function macZip(info: UpdateInfo): UpdateInfo['files'][number] | undefined {
  const zips = info.files.filter((f) => f.url.endsWith('.zip'))
  return zips.find((f) => f.url.includes(`-${process.arch}.`)) ?? (zips.length === 1 && process.arch === 'arm64' ? zips[0] : undefined)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/** The release's notes as plain text, shown in Settings (GitHub sends them as HTML). */
export function releaseNotes(info: Pick<UpdateInfo, 'releaseNotes'>): string | undefined {
  const raw = info.releaseNotes
  const html = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((n) => n.note ?? '').join('\n') : ''
  const text = html
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|pre)>|<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#39|[a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) return undefined
  return text.length > 2000 ? `${text.slice(0, 2000).trimEnd()}…` : text
}

function friendlyError(raw: string): string {
  if (/net::ERR_|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(raw)) return 'Could not reach GitHub to check for updates.'
  if (/HttpError: 40[34]|rate limit/i.test(raw)) return 'GitHub did not answer the update check. Try again later.'
  const first = raw.split('\n')[0].trim()
  return first.length > 200 ? `${first.slice(0, 200)}…` : first
}
