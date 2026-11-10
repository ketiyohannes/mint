import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentError, type AgentTurnRequest } from '../../src/main/agents/types'
import type { SpawnFn } from '../../src/main/agents/codex/jsonrpc'
import { CodexRuntime, parseStructuredOutput, resolveCodexPath } from '../../src/main/agents/codex/runtime'

const FAKE_SERVER = fileURLToPath(new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url))

/** Runs the fake app-server with node instead of the codex binary; counts spawns. */
function fakeSpawn(extraEnv: Record<string, string> = {}): SpawnFn & { spawned: number } {
  const fn = ((_command, args, options) => {
    fn.spawned++
    return spawn(process.execPath, [FAKE_SERVER, ...args], { ...options, env: { ...options.env, ...extraEnv } })
  }) as SpawnFn & { spawned: number }
  fn.spawned = 0
  return fn
}

const runtimes: CodexRuntime[] = []
function makeRuntime(options: ConstructorParameters<typeof CodexRuntime>[0] = {}): CodexRuntime {
  const runtime = new CodexRuntime({ codexPath: 'codex', spawnImpl: fakeSpawn(), ...options })
  runtimes.push(runtime)
  return runtime
}

function request(prompt: string, extra: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return { purpose: 'test', system: 'You are a tutor.', prompt, cwd: process.cwd(), readFiles: false, ...extra }
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.dispose()))
})

describe('CodexRuntime (fake app-server)', () => {
  it('streams agent message deltas and returns the final text', async () => {
    const runtime = makeRuntime()
    const deltas: string[] = []
    const result = await runtime.run(request('hi there', { onDelta: (d) => deltas.push(d) }))
    expect(result.text).toBe('Hello from fake codex: hi there')
    expect(result.structured).toBeUndefined()
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.join('')).toBe(result.text)
    expect(deltas.join('')).not.toContain('SECRET_REASONING')
  })

  it('separates commentary from the answer in the stream but returns only the final answer', async () => {
    const runtime = makeRuntime()
    const deltas: string[] = []
    const result = await runtime.run(request('COMMENTARY please', { onDelta: (d) => deltas.push(d) }))
    expect(result.text).toBe('Hello from fake codex: COMMENTARY please')
    expect(deltas.join('')).toBe('Thinking out loud.\n\nHello from fake codex: COMMENTARY please')
  })

  it('sends the expected thread/start and turn/start parameters', async () => {
    const runtime = makeRuntime({ model: 'gpt-test' })
    const schemaless = await runtime.run(request('ECHO_PARAMS', { readFiles: true, web: { allowedDomains: ['en.wikipedia.org'] }, effort: 'low' }))
    const sent = JSON.parse(schemaless.text) as { thread: Record<string, unknown>; turn: Record<string, unknown> }
    expect(sent.thread).toMatchObject({
      cwd: process.cwd(),
      model: 'gpt-test',
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      config: { web_search: 'live', tools: { web_search: { allowed_domains: ['en.wikipedia.org'] } } }
    })
    expect(sent.thread.developerInstructions).toContain('You are a tutor.')
    expect(sent.thread.developerInstructions).toContain('en.wikipedia.org')
    expect(sent.turn).toMatchObject({
      input: [{ type: 'text', text: 'ECHO_PARAMS', text_elements: [] }],
      effort: 'low'
    })
    expect(sent.turn).not.toHaveProperty('outputSchema')

    const noWeb = JSON.parse((await runtime.run(request('ECHO_PARAMS'))).text) as { thread: Record<string, unknown> }
    expect(noWeb.thread.config).toEqual({ web_search: 'disabled' })
    expect(noWeb.thread.developerInstructions).toContain('Do not run shell commands')
  })

  it('parses structured output, including fenced JSON', async () => {
    const runtime = makeRuntime()
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
    expect((await runtime.run(request('plain', { schema }))).structured).toEqual({ answer: 'plain' })
    expect((await runtime.run(request('FENCED', { schema }))).structured).toEqual({ answer: 'FENCED' })
  })

  it('rejects unparseable structured output with kind invalid-output', async () => {
    const runtime = makeRuntime()
    const err = await runtime.run(request('BADJSON', { schema: { type: 'object' } })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).kind).toBe('invalid-output')
  })

  it('auto-declines command approvals', async () => {
    const logs: string[] = []
    const runtime = makeRuntime({ log: (m) => logs.push(m) })
    const result = await runtime.run(request('NEED_APPROVAL'))
    expect(result.text).toContain('decision=decline')
    expect(logs.some((l) => l.includes('declined command approval'))).toBe(true)
  })

  it('maps a failed turn to AgentError(failed) with the turn error message', async () => {
    const runtime = makeRuntime()
    const err = await runtime.run(request('FAIL')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).kind).toBe('failed')
    expect((err as AgentError).message).toContain('model exploded')
  })

  it('maps unauthorized turn failures and logged-out accounts to kind auth', async () => {
    const runtime = makeRuntime()
    const err = await runtime.run(request('AUTHFAIL')).catch((e: unknown) => e)
    expect((err as AgentError).kind).toBe('auth')
    expect((err as AgentError).message).toContain('codex login')

    const loggedOut = makeRuntime({ spawnImpl: fakeSpawn({ FAKE_CODEX_LOGGED_OUT: '1' }) })
    const err2 = await loggedOut.run(request('hello')).catch((e: unknown) => e)
    expect((err2 as AgentError).kind).toBe('auth')
    expect(await loggedOut.check()).toEqual({ ok: false, message: expect.stringContaining('codex login') })
  })

  it('interrupts the turn on abort and rejects with kind aborted', async () => {
    const runtime = makeRuntime()
    const controller = new AbortController()
    const pending = runtime.run(request('HANG', { signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    const err = await pending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).kind).toBe('aborted')
    expect((err as AgentError).message).toBe('Cancelled')
    // The process is still healthy afterwards.
    expect((await runtime.run(request('after abort'))).text).toContain('after abort')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const runtime = makeRuntime()
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.run(request('x', { signal: controller.signal }))).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('times out a turn that never completes', async () => {
    const runtime = makeRuntime({ turnTimeoutMs: 150 })
    const err = await runtime.run(request('HANG')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).message).toContain('timed out')
  })

  it('routes concurrent runs on one process by thread', async () => {
    const spawnImpl = fakeSpawn()
    const runtime = makeRuntime({ spawnImpl })
    const a: string[] = []
    const b: string[] = []
    const [ra, rb] = await Promise.all([runtime.run(request('SLOW alpha', { onDelta: (d) => a.push(d) })), runtime.run(request('SLOW beta', { onDelta: (d) => b.push(d) }))])
    expect(ra.text).toBe('Hello from fake codex: SLOW alpha')
    expect(rb.text).toBe('Hello from fake codex: SLOW beta')
    expect(a.join('')).toBe(ra.text)
    expect(b.join('')).toBe(rb.text)
    expect(spawnImpl.spawned).toBe(1)
  })

  it('fails in-flight runs when the process crashes and restarts on the next run', async () => {
    const spawnImpl = fakeSpawn()
    const runtime = makeRuntime({ spawnImpl })
    const err = await runtime.run(request('CRASH')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).kind).toBe('unavailable')
    expect((err as AgentError).message).toContain('simulated crash')
    expect((err as AgentError).message).not.toContain('\u001b[')

    const result = await runtime.run(request('back again'))
    expect(result.text).toBe('Hello from fake codex: back again')
    expect(spawnImpl.spawned).toBe(2)
  })

  it('check() reports readiness and the login method without running a turn', async () => {
    const runtime = makeRuntime()
    expect(await runtime.check()).toEqual({ ok: true, message: 'Codex app-server ready (ChatGPT login)' })
  })

  it('reports a missing binary as unavailable', async () => {
    const runtime = makeRuntime({ codexPath: '/nonexistent/codex', spawnImpl: undefined })
    const err = await runtime.run(request('x')).catch((e: unknown) => e)
    expect((err as AgentError).kind).toBe('unavailable')
    expect((await runtime.check()).ok).toBe(false)
  })

  it('refuses to run after dispose()', async () => {
    const runtime = makeRuntime()
    await runtime.check()
    await runtime.dispose()
    await expect(runtime.run(request('x'))).rejects.toMatchObject({ kind: 'unavailable' })
  })
})

describe('codex helpers', () => {
  it('parseStructuredOutput tolerates fences and surrounding prose', () => {
    expect(parseStructuredOutput('{"a":1}')).toEqual({ a: 1 })
    expect(parseStructuredOutput('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseStructuredOutput('```\n[1,2]\n```')).toEqual([1, 2])
    expect(parseStructuredOutput('Here you go: {"a":1} done')).toEqual({ a: 1 })
    expect(() => parseStructuredOutput('no json here')).toThrow()
  })

  it('resolveCodexPath prefers an explicit path, then PATH', () => {
    expect(resolveCodexPath('/custom/codex')).toBe('/custom/codex')
    // node is executable; a PATH containing only its directory must not resolve "codex" there.
    const found = resolveCodexPath(undefined, '/definitely/not/a/dir')
    expect(found === null || found.endsWith('codex')).toBe(true)
  })
})
