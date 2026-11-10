/**
 * The `mint-sandbox:` protocol that serves the diagram sandbox page
 * (resources/diagram-sandbox/) to an <iframe sandbox="allow-scripts">.
 *
 * Wiring (in the main entry point):
 *   registerDiagramScheme()                         // before app 'ready'
 *   app.whenReady().then(() => {
 *     handleDiagramProtocol(diagramResourcesDir())
 *     ...
 *   })
 *   restrictDiagramFrameNavigation(window.webContents)   // each window that hosts diagram frames
 *
 * The renderer's own CSP must allow the frame: `frame-src mint-sandbox:`.
 */

import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import electron, { type WebContents } from 'electron'

// Electron's ESM loader only exposes a default export for 'electron'.
const { app, protocol } = electron
import { CODE_RUNNER_CSP, DIAGRAM_SANDBOX_CSP, DIAGRAM_SANDBOX_HOST, DIAGRAM_SANDBOX_SCHEME } from '@shared/diagramProtocol'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Pyodide runtime files for the code runner.
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.json': 'application/json; charset=utf-8'
}

const RUNTIME_ONLY = new Set(['.wasm', '.zip', '.json'])

/** Must run before the app's 'ready' event. */
export function registerDiagramScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DIAGRAM_SANDBOX_SCHEME,
      // fetch + CORS let the code runner's workers (opaque origin) load the local Pyodide files.
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/**
 * Maps a sandbox URL to an absolute file path inside `<resourcesDir>/diagram-sandbox/`.
 * Returns null for a foreign scheme or host, unsupported file types, encoded
 * separators/NULs, or any path that would escape the sandbox directory.
 */
export function resolveSandboxPath(resourcesDir: string, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${DIAGRAM_SANDBOX_SCHEME}:` || parsed.hostname !== DIAGRAM_SANDBOX_HOST) return null

  // WHATWG URL parsing already collapses literal `..` segments; reject the
  // encoded forms that survive it (%2e%2e, %2f, %5c) and anything malformed.
  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null
  const segments = pathname.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) segments.push('index.html')
  // No dot-segments and no hidden files (build stamps and the like).
  if (segments.some((s) => s.startsWith('.'))) return null
  const ext = extname(segments[segments.length - 1]).toLowerCase()
  if (!(ext in CONTENT_TYPES)) return null
  // Runtime data files are only served from the Pyodide folder.
  if (RUNTIME_ONLY.has(ext) && segments[0] !== 'pyodide') return null

  const root = resolve(resourcesDir, 'diagram-sandbox')
  const filePath = resolve(root, ...segments)
  return filePath.startsWith(root + sep) ? filePath : null
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

/** Serves the sandbox directory on `mint-sandbox://app/…`. Call after app 'ready'. */
export function handleDiagramProtocol(resourcesDir: string): void {
  protocol.handle(DIAGRAM_SANDBOX_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    const filePath = resolveSandboxPath(resourcesDir, request.url)
    if (!filePath) return notFound()
    let body: Buffer
    try {
      body = await readFile(filePath)
    } catch {
      return notFound()
    }
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPES[extname(filePath).toLowerCase()],
        'Content-Security-Policy': filePath.endsWith(`${sep}runner.html`) ? CODE_RUNNER_CSP : DIAGRAM_SANDBOX_CSP,
        // Sandboxed frames have an opaque ("null") origin; their workers fetch these files cross-origin.
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache'
      }
    })
  })
}

/** Directory containing `diagram-sandbox/`: the repo's resources/ in dev, the packaged copy otherwise. */
export function diagramResourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
}

/**
 * Defense in depth for a WebContents that hosts diagram iframes: a sandbox
 * frame may only ever navigate within `mint-sandbox://app/` (a sketch could
 * otherwise do `location.href = 'https://…'` and reach the network).
 */
export function restrictDiagramFrameNavigation(contents: WebContents): void {
  const sandboxOrigin = `${DIAGRAM_SANDBOX_SCHEME}://${DIAGRAM_SANDBOX_HOST}/`
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || !event.frame) return
    if (!event.frame.url.startsWith(sandboxOrigin)) return
    if (!event.url.startsWith(sandboxOrigin)) event.preventDefault()
  })
}
