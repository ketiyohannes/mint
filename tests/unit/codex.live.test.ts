import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexRuntime } from '../../src/main/agents/codex/runtime'

/**
 * Talks to the real `codex app-server` (needs a logged-in Codex CLI and makes
 * two tiny model calls). Run with: MINT_LIVE_CODEX=1 npx vitest run tests/unit/codex.live
 */
const live = process.env.MINT_LIVE_CODEX === '1'

describe.skipIf(!live)('CodexRuntime (live codex app-server)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mint-codex-live-'))
  const logs: string[] = []
  const runtime = new CodexRuntime({ log: (m) => logs.push(m) })

  afterAll(async () => {
    // Surface protocol warnings (e.g. a rejected thread/unsubscribe) in the run output.
    if (logs.some((l) => l.includes('failed'))) console.warn(logs.join('\n'))
    await runtime.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('check() confirms the app-server and login without a model turn', async () => {
    const result = await runtime.check()
    expect(result.ok, result.message).toBe(true)
    expect(result.message).toMatch(/^Codex app-server ready/)
  }, 60_000)

  it('runs a plain streaming turn', async () => {
    const deltas: string[] = []
    const result = await runtime.run({
      purpose: 'live-smoke',
      system: 'You are a terse assistant.',
      prompt: 'Reply with the single word: ready',
      cwd,
      readFiles: false,
      effort: 'low',
      onDelta: (d) => deltas.push(d)
    })
    expect(result.text.toLowerCase()).toContain('ready')
    expect(deltas.join('')).toContain(result.text)
  }, 180_000)

  it('runs a structured-output turn', async () => {
    const result = await runtime.run({
      purpose: 'live-smoke-structured',
      system: 'You are a terse assistant.',
      prompt: 'Set "answer" to the single word: ready',
      cwd,
      readFiles: false,
      effort: 'low',
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false
      }
    })
    expect(result.structured).toEqual({ answer: expect.stringMatching(/ready/i) })
  }, 180_000)

  it('accepts a domain-restricted web search config', async () => {
    const result = await runtime.run({
      purpose: 'live-smoke-web-config',
      system: 'You are a terse assistant. Do not search; answer directly.',
      prompt: 'Reply with the single word: ok',
      cwd,
      readFiles: true,
      effort: 'low',
      web: { allowedDomains: ['en.wikipedia.org'] }
    })
    expect(result.text.toLowerCase()).toContain('ok')
  }, 180_000)

  it('interrupts a real turn on abort, then keeps working', async () => {
    const controller = new AbortController()
    const pending = runtime.run({
      purpose: 'live-smoke-abort',
      system: 'You are a terse assistant.',
      prompt: 'Count from 1 to 300, one number per line.',
      cwd,
      readFiles: false,
      effort: 'low',
      signal: controller.signal,
      onDelta: () => controller.abort()
    })
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
    const after = await runtime.run({
      purpose: 'live-smoke-after-abort',
      system: 'You are a terse assistant.',
      prompt: 'Reply with the single word: ready',
      cwd,
      readFiles: false,
      effort: 'low'
    })
    expect(after.text.toLowerCase()).toContain('ready')
    expect(logs.filter((l) => /interrupt failed|unsubscribe failed/.test(l))).toEqual([])
  }, 180_000)
})
