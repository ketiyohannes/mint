import electron from 'electron'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import { join, delimiter, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { API_GROUPS, EVENT_CHANNELS } from '@shared/api'
import { createCore, type MintCore } from './app'
import type { SecretCipher } from './store/settingsStore'
import { AgentError } from './agents/types'
import { diagramResourcesDir, handleDiagramProtocol, registerDiagramScheme, restrictDiagramFrameNavigation } from './diagramProtocol'
import { createFixtureFetch } from './testing/fixtureFetch'

// Electron's ESM loader only exposes a default export for 'electron'.
const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = electron

const isE2E = process.env.MINT_E2E === '1'
const here = dirname(fileURLToPath(import.meta.url))

// Must run before the app is ready.
registerDiagramScheme()
if (process.env.MINT_USER_DATA) app.setPath('userData', process.env.MINT_USER_DATA)

if (!isE2E && !app.requestSingleInstanceLock()) app.quit()

let mainWindow: BrowserWindowType | null = null
let core: MintCore | null = null

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
  if (err instanceof AgentError) return new Error(`mint:${err.message}`)
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.startsWith('mint:')) return new Error(msg)
  console.error('[mint] unexpected error:', err)
  return new Error(`mint:Something went wrong: ${msg.slice(0, 300)}`)
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'mint',
    backgroundColor: '#fbfaf6',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true
    }
  })

  const contents = mainWindow.webContents
  restrictDiagramFrameNavigation(contents)
  // The app never navigates away from itself; external links open in the browser.
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.once('ready-to-show', () => {
    if (!isE2E || process.env.MINT_E2E_SHOW === '1') mainWindow?.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(here, '../renderer/index.html'))
}

function configureSession(): void {
  const ses = session.defaultSession
  // Only the microphone (push-to-talk) may be requested; everything else is denied.
  const isAppUrl = (url: string | undefined) =>
    Boolean(url && (url.startsWith('file://') || (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))))
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const d = details as { mediaTypes?: string[]; requestingUrl?: string; isMainFrame?: boolean }
    const media = permission === 'media' && d.isMainFrame !== false && isAppUrl(d.requestingUrl) && (d.mediaTypes ?? []).every((t) => t === 'audio')
    callback(media)
  })
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permission === 'media' && isAppUrl(requestingOrigin))
  // YouTube's embedded player refuses to play without a referrer; app pages have none.
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*'] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, Referer: 'https://mint.local/' } })
  })
}

app.whenReady().then(async () => {
  // Packaged: <resources>/resources. Dev and tests: <repo>/resources (out/main is two levels down).
  handleDiagramProtocol(app.isPackaged ? diagramResourcesDir() : join(here, '../../resources'))
  configureSession()

  const fixtures = isE2E ? process.env.MINT_E2E_FIXTURES : undefined
  core = createCore({
    dataDir: dataDir(),
    cipher: cipher(),
    fetchImpl: fixtures ? createFixtureFetch(fixtures) : undefined,
    log: (m) => console.log(`[mint] ${m}`),
    emitter: {
      stream: (e) => send(EVENT_CHANNELS.stream, e),
      progress: (e) => send(EVENT_CHANNELS.progress, e),
      classChanged: (id) => send(EVENT_CHANNELS.classChanged, id)
    },
    host: {
      platform: process.platform,
      openExternal: (url) => shell.openExternal(url),
      openPath: async (p) => {
        await shell.openPath(p)
      },
      pickFiles: async () => {
        if (isE2E) return (process.env.MINT_E2E_PICK ?? '').split(delimiter).filter(Boolean)
        const res = await dialog.showOpenDialog(mainWindow!, {
          title: 'Add your materials',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Readable files', extensions: ['pdf', 'md', 'markdown', 'txt', 'html', 'htm', 'docx'] }]
        })
        return res.canceled ? [] : res.filePaths
      }
    }
  })
  registerIpc(core)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isE2E) app.quit()
})

app.on('before-quit', () => {
  void core?.dispose()
})
