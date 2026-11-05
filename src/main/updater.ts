import electron from 'electron'
import updaterModule from 'electron-updater'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { access, constants, mkdir, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateState, UpdateStatus } from '@shared/types'
import type { UpdateController } from './app'

const { app, net } = electron
const run = promisify(execFile)

/** Where releases are published (matches `publish` in electron-builder.yml). */
const RELEASES = { owner: 'ketiyohannes', repo: 'mint' } as const
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

/**
 * Swaps the app bundle once mint has exited, then relaunches it. Runs detached
 * from mint: $1 pid to wait for, $2 installed bundle, $3 verified new bundle,
 * $4 relaunch (1/0). A failed swap puts the old bundle back.
 */
const MAC_SWAP_SCRIPT = `
pid="$1"; target="$2"; staged="$3"; relaunch="$4"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 600 ] && exit 1
  sleep 0.2
done
backup="$target.previous-$$"
if mv "$target" "$backup"; then
  if mv "$staged" "$target"; then rm -rf "$backup"; else mv "$backup" "$target"; fi
fi
[ "$relaunch" = 1 ] && open "$target"
exit 0
`

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
}

/**
 * Checks GitHub releases for a newer mint, downloads it on request and
 * installs it on restart.
 *
 * Windows and Linux use electron-updater end to end. macOS builds are ad-hoc
 * signed, which Squirrel.Mac rejects, so there electron-updater only reads the
 * release feed: mint downloads the zip itself, checks its SHA-512, signature
 * and version, and a small script swaps the bundle after mint quits.
 */
export class Updater implements UpdateController {
  private state: UpdateState
  private info: UpdateInfo | null = null
  /** macOS: the verified new bundle, waiting to replace the installed one. */
  private staged: string | null = null
  private swapping = false
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
    u.on('download-progress', (p: ProgressInfo) => this.progress(p.percent))
    if (process.platform === 'darwin') void rm(this.stagingDir(), { recursive: true, force: true }).catch(() => undefined)
  }

  /** Check shortly after launch, then every few hours. */
  start(): void {
    if (!this.updater) return
    const quietCheck = () => {
      if (['idle', 'current', 'error', 'available'].includes(this.state.status)) void this.check()
    }
    this.timers.push(setTimeout(quietCheck, FIRST_CHECK_MS), setInterval(quietCheck, CHECK_EVERY_MS))
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  status = async (): Promise<UpdateStatus> => this.snapshot()

  check = async (): Promise<UpdateStatus> => {
    const u = this.updater
    if (!u || this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'ready') return this.snapshot()
    this.set({ status: 'checking' })
    try {
      const result = await u.checkForUpdates()
      if (!result?.isUpdateAvailable) {
        this.info = null
        this.set({ status: 'current', checkedAt: new Date().toISOString() })
      } else {
        this.info = result.updateInfo
        const version = result.updateInfo.version
        this.set({ status: 'available', version, releaseUrl: releaseUrl(version), installable: await this.installable(result.updateInfo) })
      }
    } catch (err) {
      this.fail(err)
    }
    return this.snapshot()
  }

  download = async (): Promise<UpdateStatus> => {
    const u = this.updater
    const info = this.info
    if (!u || !info || this.state.status !== 'available' || !this.state.installable) return this.snapshot()
    const version = info.version
    this.set({ status: 'downloading', version, releaseUrl: releaseUrl(version), percent: 0 })
    try {
      if (process.platform === 'darwin') this.staged = await this.downloadMac(info)
      else await u.downloadUpdate()
      this.set({ status: 'ready', version, releaseUrl: releaseUrl(version) })
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
        this.updater?.quitAndInstall(true, true)
      }
    })
  }

  /** macOS: an update downloaded but not yet installed is applied when mint quits. */
  applyOnQuit(): void {
    if (process.platform === 'darwin' && this.state.status === 'ready') this.swapMac(false)
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
    const version = this.info?.version
    this.set({ status: 'error', message: friendlyError(raw), releaseUrl: version ? releaseUrl(version) : latestReleasesUrl() })
  }

  /** Whether this copy of mint can replace itself; otherwise the release page is offered. */
  private async installable(info: UpdateInfo): Promise<boolean> {
    const exe = app.getPath('exe')
    if (process.platform === 'darwin') {
      const bundle = macBundle()
      if (!bundle || !macZip(info)) return false
      // Run from a disk image or a quarantined download (App Translocation): nothing to replace.
      if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return false
      try {
        await access(bundle, constants.W_OK)
        await access(dirname(bundle), constants.W_OK)
        return true
      } catch {
        return false
      }
    }
    // The zip build has no uninstaller; the setup installer would put a second copy elsewhere.
    if (process.platform === 'win32') return existsSync(join(dirname(exe), 'Uninstall mint.exe'))
    // AppImage, or a .deb install (electron-builder leaves a package-type marker).
    return Boolean(process.env.APPIMAGE) || existsSync(join(process.resourcesPath, 'package-type'))
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
    const res = await net.fetch(url)
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`)
    const total = Number(res.headers.get('content-length')) || file.size || 0

    const zip = join(dir, 'update.zip')
    const out = createWriteStream(zip)
    const hash = createHash('sha512')
    const reader = res.body.getReader()
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        received += value.byteLength
        if (!out.write(value)) await once(out, 'drain')
        if (total) this.progress((received / total) * 100)
      }
    } finally {
      out.end()
      await once(out, 'close')
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
    const target = macBundle()
    if (this.swapping || !this.staged || !target) return
    this.swapping = true
    this.opts.log(`update: replacing ${target} on exit${relaunch ? ' and relaunching' : ''}`)
    spawn('/bin/sh', ['-c', MAC_SWAP_SCRIPT, 'mint-update', String(process.pid), target, this.staged, relaunch ? '1' : '0'], {
      detached: true,
      stdio: 'ignore'
    }).unref()
  }
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

function releaseUrl(version: string): string {
  return `https://github.com/${RELEASES.owner}/${RELEASES.repo}/releases/tag/v${version}`
}

function latestReleasesUrl(): string {
  return `https://github.com/${RELEASES.owner}/${RELEASES.repo}/releases`
}

function friendlyError(raw: string): string {
  if (/net::ERR_|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(raw)) return 'Could not reach GitHub to check for updates.'
  if (/HttpError: 40[34]|rate limit/i.test(raw)) return 'GitHub did not answer the update check. Try again later.'
  const first = raw.split('\n')[0].trim()
  return first.length > 200 ? `${first.slice(0, 200)}…` : first
}
