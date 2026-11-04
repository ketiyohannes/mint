import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The module under test imports Electron; only its pure path resolver is exercised here.
vi.mock('electron', () => ({ default: { app: {}, protocol: {} }, app: {}, protocol: {} }))

const { resolveSandboxPath } = await import('../../src/main/diagramProtocol')

const resources = resolve('/opt/mint/resources')
const root = join(resources, 'diagram-sandbox')

describe('resolveSandboxPath', () => {
  it('serves files inside diagram-sandbox/', () => {
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/index.html')).toBe(join(root, 'index.html'))
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/runtime.js')).toBe(join(root, 'runtime.js'))
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/vendor/p5.min.js')).toBe(join(root, 'vendor', 'p5.min.js'))
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/sandbox.css?v=2#x')).toBe(join(root, 'sandbox.css'))
  })

  it('maps the bare origin to index.html', () => {
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/')).toBe(join(root, 'index.html'))
    expect(resolveSandboxPath(resources, 'mint-sandbox://app')).toBe(join(root, 'index.html'))
  })

  it('rejects path traversal in every encoding', () => {
    for (const url of [
      'mint-sandbox://app/../secrets.js',
      'mint-sandbox://app/vendor/../../secrets.js',
      'mint-sandbox://app/%2e%2e/secrets.js',
      'mint-sandbox://app/%2E%2E/%2E%2E/secrets.js',
      'mint-sandbox://app/..%2fsecrets.js',
      'mint-sandbox://app/vendor%2f..%2f..%2fsecrets.js',
      'mint-sandbox://app/..%5csecrets.js',
      'mint-sandbox://app/%5c..%5c..%5csecrets.js',
      'mint-sandbox://app/index.html%00.js',
      'mint-sandbox://app/%E0%A4%A.js'
    ]) {
      const result = resolveSandboxPath(resources, url)
      if (result !== null) expect(result.startsWith(root + '/') || result.startsWith(root + '\\'), url).toBe(true)
      else expect(result).toBeNull()
    }
    // Explicit expectations for the encoded forms that WHATWG URL parsing does not collapse.
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/..%2fsecrets.js')).toBeNull()
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/..%5csecrets.js')).toBeNull()
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/index.html%00.js')).toBeNull()
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/%E0%A4%A.js')).toBeNull()
  })

  it('rejects other schemes, hosts and file types', () => {
    expect(resolveSandboxPath(resources, 'file:///etc/passwd')).toBeNull()
    expect(resolveSandboxPath(resources, 'https://app/index.html')).toBeNull()
    expect(resolveSandboxPath(resources, 'mint-sandbox://evil/index.html')).toBeNull()
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/vendor/.stamp.json')).toBeNull()
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/README.md')).toBeNull()
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/vendor')).toBeNull()
    expect(resolveSandboxPath(resources, 'not a url')).toBeNull()
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/fixtures.json')).toBeNull()
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/.hidden.js')).toBeNull()
  })

  it('serves the code runner and its local Python runtime', () => {
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/runner.html')).toMatch(/runner\.html$/)
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/pyodide/pyodide.asm.wasm')).toMatch(/pyodide\.asm\.wasm$/)
    expect(resolveSandboxPath(resources, 'mint-sandbox://app/pyodide/pyodide-lock.json')).toMatch(/pyodide-lock\.json$/)
  })
})
