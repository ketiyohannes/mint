import electron from 'electron'
import type { BrowserWindow as BrowserWindowType, OpenDialogOptions, Rectangle, WebContents } from 'electron'
import { join, delimiter, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { API_GROUPS, EVENT_CHANNELS, USER_ERROR_PREFIX } from '@shared/api'
import { createCore, type MintCore } from './app'
import type { SecretCipher } from './store/settingsStore'
import { AgentError } from './agents/types'
import { diagramResourcesDir, handleDiagramProtocol, registerDiagramScheme, restrictDiagramFrameNavigation } from './diagramProtocol'
import { createFixtureFetch } from './testing/fixtureFetch'
import { Updater } from './updater'
import { Popouts, type PopoutSize } from './windows'
import type { PopoutKind } from '@shared/types'

// Electron's ESM loader only exposes a default export for 'electron'.
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, screen, session, shell } = electron

const isE2E = process.env.MINT_E2E === '1'
const here = dirname(fileURLToPath(import.meta.url))

// Must run before the app is ready.
registerDiagramScheme()

/**
 * A development copy (`npm run dev`) keeps its own profile beside the installed
 * app's, so the two neither share data nor compete for the single-instance
 * lock. MINT_DEV_PROFILE=0 uses the installed app's profile instead.
 */
const isDevProfile = !app.isPackaged && !isE2E && !process.env.MINT_USER_DATA && process.env.MINT_DEV_PROFILE !== '0'
if (process.env.MINT_USER_DATA) app.setPath('userData', process.env.MINT_USER_DATA)
else if (isDevProfile) app.setPath('userData', join(app.getPath('appData'), 'mint-dev'))

// A second copy hands over to the first and sets nothing up: it would be working on the same data.
const hasInstanceLock = isE2E || app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()

let mainWindow: BrowserWindowType | null = null
let core: MintCore | null = null
let updater: Updater | null = null
let popouts: Popouts | null = null
/** The pages of mint's own windows (the main one and the parts moved out of it). */
const appContents = new Set<WebContents>()

function dataDir(): string {
  const dir = process.env.MINT_DATA_DIR || join(app.getPath('userData'), 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

function cipher(): SecretCipher {
  if (isE2E) {
    // Tests must not touch the system keychain.
    return {
      available: () => true,
      encrypt: (p) => Buffer.from(p, 'utf8').toString('base64'),
      decrypt: (c) => Buffer.from(c, 'base64').toString('utf8')
    }
  }
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (p) => safeStorage.encryptString(p).toString('base64'),
    decrypt: (c) => safeStorage.decryptString(Buffer.from(c, 'base64'))
  }
}

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, payload)
}

/** Map any thrown value to an Error whose message the renderer can show. */
function toIpcError(err: unknown): Error {
  if (err instanceof AgentError) return new Error(`${USER_ERROR_PREFIX}${err.message}`)
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.startsWith(USER_ERROR_PREFIX)) return new Error(msg)
  console.error('[mint] unexpected error:', err)
  return new Error(`${USER_ERROR_PREFIX}Something went wrong: ${msg.slice(0, 300)}`)
}

function registerIpc(c: MintCore): void {
  for (const [group, methods] of Object.entries(API_GROUPS)) {
    for (const method of methods) {
      const handler = (c.handlers as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>)[group][method]
      ipcMain.handle(`${group}:${method}`, async (_event, ...args: unknown[]) => {
        try {
          return await handler(...args)
        } catch (err) {
          throw toIpcError(err)
        }
      })
    }
  }
}

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'
/**
 * Windows has no native title bar or menu, like macOS: the app's headers drag
 * the window and Windows draws its own buttons over the top-right corner, in
 * the header's colours (1px short of the 52px header, so its border shows).
 */
const WINDOW_CONTROLS = {
  light: { color: '#f6f6f4', symbolColor: '#161616' },
  dark: { color: '#111111', symbolColor: '#e7e7e5' },
  height: 51
}
/** Whether the interface is dark. The window is painted in the theme's background until the page has drawn itself, so a dark theme never flashes white. */
let darkWindow = false

/**
 * One of mint's windows: the main one, or a part of it (the lesson, the panel)
 * in a window of its own. They are the same app, shown in a different view,
 * with the same restrictions.
 */
function openWindow(view: 'main' | PopoutKind, size: PopoutSize, at: Rectangle | null): BrowserWindowType {
  const colors = darkWindow ? WINDOW_CONTROLS.dark : WINDOW_CONTROLS.light
  const win = new BrowserWindow({
    ...size,
    ...(at ?? {}),
    show: false,
    title: isDevProfile ? 'mint (dev)' : 'mint',
    backgroundColor: colors.color,
    titleBarStyle: isMac ? 'hiddenInset' : isWindows ? 'hidden' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    ...(isWindows ? { titleBarOverlay: { ...colors, height: WINDOW_CONTROLS.height } } : {}),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The Browser tab is a <webview>; it is hardened in will-attach-webview below.
      webviewTag: true,
      spellcheck: true,
      // A hidden window stops drawing on Windows and Linux, and each click the test makes then waits out a timeout.
      ...(isE2E ? { backgroundThrottling: false } : {})
    }
  })
  // The page's own <title> would replace the development marker.
  if (isDevProfile && view === 'main') win.on('page-title-updated', (event) => event.preventDefault())

  // No File/Edit/View menu bar on Windows and Linux (editing shortcuts still work in the page).
  if (!isMac) win.removeMenu()

  const contents = win.webContents
  appContents.add(contents)
  win.on('closed', () => appContents.delete(contents))
  // From source there is no menu to open the developer tools from on Windows and Linux: F12 does it everywhere.
  if (!app.isPackaged && !isE2E) {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F12') return
      event.preventDefault()
      contents.toggleDevTools()
    })
  }
  restrictDiagramFrameNavigation(contents)
  // The app never navigates away from itself; external links open in the browser.
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Browser tab: an isolated, sandboxed guest with no preload and its own session.
  contents.on('will-attach-webview', (event, prefs, params) => {
    delete (prefs as { preload?: string }).preload
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    prefs.webSecurity = true
    params.partition = BROWSER_PARTITION
    if (params.src && !/^https?:\/\//i.test(params.src) && params.src !== 'about:blank') event.preventDefault()
  })

  win.once('ready-to-show', () => {
    if (windowsVisible) win.show()
  })

  // The page reads which view it is from the address.
  const query = view === 'main' ? undefined : { view }
  const dev = process.env.ELECTRON_RENDERER_URL
  const loaded = dev ? win.loadURL(query ? `${dev}?${new URLSearchParams(query)}` : dev) : win.loadFile(join(here, '../renderer/index.html'), { query })
  loaded.catch((err) => console.error('[mint] could not load the window:', err))
  return win
}

/** Tests drive hidden windows unless asked to show them. */
const windowsVisible = !isE2E || process.env.MINT_E2E_SHOW === '1'

function createWindow(): void {
  const win = openWindow('main', { width: 1440, height: 920, minWidth: 1040, minHeight: 680 }, null)
  mainWindow = win
  win.on('closed', () => {
    // macOS keeps running without its window; nothing may reach for a destroyed one.
    if (mainWindow === win) mainWindow = null
    // The lesson and the panel belong to the main window's chat: they go with it.
    popouts?.closeAll()
  })
}

const BROWSER_PARTITION = 'persist:mint-browser'

/** The Browser tab's guest pages: web only, popups open in the same tab, no permissions. */
function configureBrowser(): void {
  const ses = session.fromPartition(BROWSER_PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview') return
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void wc.loadURL(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault()
    })
  })
}

/**
 * The app's own session needs no device permissions (camera, microphone,
 * location…) and gets only the two it uses: full screen, for the embedded
 * video player, and writing text to the clipboard ("Copy reply"), which only
 * the page of one of mint's windows may do, not a frame inside it (the video,
 * a diagram sandbox).
 */
function appPermission(contents: WebContents | null, permission: string, isMainFrame: boolean | undefined): boolean {
  if (permission === 'fullscreen') return true
  return permission === 'clipboard-sanitized-write' && isMainFrame === true && contents !== null && appContents.has(contents)
}

function configureSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((wc, permission, callback, details) => callback(appPermission(wc, permission, details.isMainFrame)))
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => appPermission(wc, permission, details.isMainFrame))
  // YouTube's embedded player refuses to play without a referrer; app pages have none.
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*'] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, Referer: 'https://mint.local/' } })
  })
}

function start(): void {
  // Packaged: <resources>/resources. Dev and tests: <repo>/resources (out/main is two levels down).
  handleDiagramProtocol(app.isPackaged ? diagramResourcesDir() : join(here, '../../resources'))
  configureSession()
  configureBrowser()

  updater = new Updater({
    disabledReason: isE2E ? 'Updates are off during tests.' : app.isPackaged ? undefined : 'This is a development build; installed copies of mint update themselves.',
    emit: (status) => send(EVENT_CHANNELS.update, status),
    log: (m) => console.log(`[mint] ${m}`),
    feedUrl: process.env.MINT_UPDATE_FEED || undefined,
    applicationsDir: process.env.MINT_UPDATE_FEED ? process.env.MINT_UPDATE_APPLICATIONS || undefined : undefined
  })

  popouts = new Popouts({
    open: openWindow,
    main: () => mainWindow,
    emit: (state) => send(EVENT_CHANNELS.popouts, state),
    relay: (message) => send(EVENT_CHANNELS.message, message),
    // A window last left on a display that is gone now would open out of sight.
    onScreen: (bounds) =>
      screen.getAllDisplays().some(({ workArea: d }) => bounds.x < d.x + d.width - 80 && bounds.x + bounds.width > d.x + 80 && bounds.y >= d.y - 8 && bounds.y < d.y + d.height - 80),
    boundsFile: join(app.getPath('userData'), 'windows.json'),
    visible: windowsVisible
  })

  const fixtures = isE2E ? process.env.MINT_E2E_FIXTURES : undefined
  core = createCore({
    dataDir: dataDir(),
    cipher: cipher(),
    fetchImpl: fixtures ? createFixtureFetch(fixtures) : undefined,
    updates: updater,
    windows: popouts,
    appVersion: app.getVersion(),
    log: (m) => console.log(`[mint] ${m}`),
    emitter: {
      stream: (e) => send(EVENT_CHANNELS.stream, e),
      progress: (e) => send(EVENT_CHANNELS.progress, e),
      classChanged: (id) => send(EVENT_CHANNELS.classChanged, id)
    },
    host: {
      platform: process.platform,
      setWindowTheme: (dark) => {
        darkWindow = dark
        const colors = dark ? WINDOW_CONTROLS.dark : WINDOW_CONTROLS.light
        for (const win of [mainWindow, ...(popouts?.all() ?? [])]) {
          win?.setBackgroundColor(colors.color)
          if (isWindows) win?.setTitleBarOverlay({ ...colors, height: WINDOW_CONTROLS.height })
        }
      },
      openExternal: (url) => shell.openExternal(url),
      openPath: async (p) => {
        await shell.openPath(p)
      },
      pickFiles: async (pick) => {
        if (isE2E) return (process.env.MINT_E2E_PICK ?? '').split(delimiter).filter(Boolean)
        const options: OpenDialogOptions = {
          title: 'Add your materials',
          buttonLabel: 'Add',
          properties: pick?.folders ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
          filters: [{ name: 'Readable files', extensions: ['pdf', 'md', 'markdown', 'txt', 'html', 'htm', 'docx'] }]
        }
        const res = await (mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options))
        return res.canceled ? [] : res.filePaths
      }
    }
  })
  registerIpc(core)
  // The saved theme decides the window's first colour; without it (a first run, an unreadable file) the system's does.
  void core.handlers.settings
    .get()
    .then(
      (s) => s.theme,
      () => 'system' as const
    )
    .then((theme) => {
      darkWindow = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
      if (!mainWindow) createWindow()
      updater?.start()
    })
    .catch(failStart)

  app.on('activate', () => {
    if (!mainWindow) createWindow()
  })
}

/** Otherwise a failed start (a data folder mint may not write, say) leaves a running app with no window and no word why. */
function failStart(err: unknown): void {
  console.error('[mint] could not start:', err)
  if (!isE2E) dialog.showErrorBox('mint could not start', err instanceof Error ? err.message : String(err))
  app.exit(1)
}

app.whenReady().then(() => {
  // Electron still reports ready to a copy that lost the lock and is on its way out.
  if (!hasInstanceLock) return
  try {
    start()
  } catch (err) {
    failStart(err)
  }
})

app.on('second-instance', () => {
  if (!mainWindow) {
    // macOS, window closed: launching mint again brings one back.
    if (core) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isE2E) app.quit()
})

/** Quitting waits this long at most for the core to wind down. */
const QUIT_GRACE_MS = 3000
let coreDisposed = false

// The core finishes first (exports still pending are written, the agent process is stopped), then the quit goes ahead.
app.on('before-quit', (event) => {
  if (coreDisposed || !core) return
  coreDisposed = true
  event.preventDefault()
  const done = core.dispose().catch(() => undefined)
  void Promise.race([done, new Promise((resolve) => setTimeout(resolve, QUIT_GRACE_MS))]).then(() => app.quit())
})

app.on('will-quit', () => {
  updater?.stop()
  updater?.applyOnQuit()
})
