import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODE_RUNNER_CSP, DIAGRAM_SANDBOX_CSP, isRunnerMessage, isSandboxMessage, SANDBOX_LIMITS } from '@shared/diagramProtocol'

describe('isSandboxMessage', () => {
  it('accepts every well-formed sandbox message', () => {
    for (const message of [
      { type: 'ready' },
      { type: 'loaded', registered: [] },
      { type: 'loaded', registered: ['bob', 'rod'] },
      { type: 'element-click', id: 'bob', label: 'Pendulum bob' },
      { type: 'hover', id: 'bob' },
      { type: 'hover', id: null },
      { type: 'error', message: 'boom' },
      { type: 'error', message: 'boom', stack: 'at draw (mint-sketch.js:3)' },
      { type: 'param-changed', id: 'length', value: 1.5 }
    ]) {
      expect(isSandboxMessage(message), JSON.stringify(message)).toBe(true)
    }
  })

  it('rejects non-objects, unknown types and host-bound messages', () => {
    for (const message of [
      null,
      undefined,
      'ready',
      42,
      [],
      {},
      { type: 'nope' },
      { type: 'load', spec: {} },
      { type: 'highlight', ids: [] }
    ]) {
      expect(isSandboxMessage(message), JSON.stringify(message)).toBe(false)
    }
  })

  it('rejects wrong field types', () => {
    for (const message of [
      { type: 'loaded' },
      { type: 'loaded', registered: [1] },
      { type: 'loaded', registered: [''] },
      { type: 'element-click', id: 'x' },
      { type: 'element-click', id: '', label: 'x' },
      { type: 'element-click', id: 3, label: 'x' },
      { type: 'hover' },
      { type: 'hover', id: 5 },
      { type: 'error' },
      { type: 'error', message: 'x', stack: 5 },
      { type: 'param-changed', id: 'a', value: '1' },
      { type: 'param-changed', id: 'a', value: Number.NaN },
      { type: 'param-changed', id: 'a', value: Infinity }
    ]) {
      expect(isSandboxMessage(message), JSON.stringify(message)).toBe(false)
    }
  })

  it('rejects oversized payloads', () => {
    expect(isSandboxMessage({ type: 'hover', id: 'x'.repeat(SANDBOX_LIMITS.id + 1) })).toBe(false)
    expect(isSandboxMessage({ type: 'error', message: 'x'.repeat(SANDBOX_LIMITS.message + 1) })).toBe(false)
    expect(
      isSandboxMessage({ type: 'loaded', registered: Array.from({ length: SANDBOX_LIMITS.registered + 1 }, (_, i) => `e${i}`) })
    ).toBe(false)
  })
})

describe('sandbox CSP', () => {
  it('index.html declares exactly the CSP the protocol handler sends', () => {
    const html = readFileSync(resolve(__dirname, '../../resources/diagram-sandbox/index.html'), 'utf8')
    const match = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)
    expect(match?.[1]).toBe(DIAGRAM_SANDBOX_CSP)
  })

  it('forbids network access', () => {
    expect(DIAGRAM_SANDBOX_CSP).toContain("default-src 'none'")
    expect(DIAGRAM_SANDBOX_CSP).toContain("connect-src 'none'")
    expect(DIAGRAM_SANDBOX_CSP).not.toMatch(/https?:/)
  })
})

describe('code runner', () => {
  it('runner.html declares exactly the CSP the protocol handler sends, without network access', () => {
    const html = readFileSync(resolve(__dirname, '../../resources/diagram-sandbox/runner.html'), 'utf8')
    const match = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)
    expect(match?.[1]).toBe(CODE_RUNNER_CSP)
    expect(CODE_RUNNER_CSP).toContain("default-src 'none'")
    expect(CODE_RUNNER_CSP).toContain('connect-src mint-sandbox:')
    expect(CODE_RUNNER_CSP).not.toMatch(/https?:/)
  })

  it('accepts only well-formed runner messages', () => {
    expect(isRunnerMessage({ type: 'runner-ready' })).toBe(true)
    expect(isRunnerMessage({ type: 'result', id: 'r1', ok: true, output: ['hi'], tests: [{ name: 't', pass: true }] })).toBe(true)
    expect(isRunnerMessage({ type: 'result', id: 'r1', ok: true, output: 'hi', tests: [] })).toBe(false)
    expect(isRunnerMessage({ type: 'result', id: 'r1', ok: true, output: [], tests: [{ name: 1, pass: true }] })).toBe(false)
    expect(isRunnerMessage({ type: 'result', id: 'x'.repeat(200), ok: true, output: [], tests: [] })).toBe(false)
    expect(isRunnerMessage({ type: 'load' })).toBe(false)
    expect(isRunnerMessage(null)).toBe(false)
  })
})
