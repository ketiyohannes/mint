import { afterEach, describe, expect, it } from 'vitest'
import {
  JSONRPC_METHOD_NOT_FOUND,
  JsonRpcError,
  JsonRpcProcessError,
  JsonRpcStdioClient,
  JsonRpcTimeoutError,
  LineBuffer
} from '../../src/main/agents/codex/jsonrpc'

/** A scriptable peer: each request method triggers one behavior. */
const PEER = String.raw`
const rl = require('node:readline').createInterface({ input: process.stdin })
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const waiting = new Map()
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === undefined) { waiting.get(m.id)?.(m); return }
  if (m.id === undefined) { out({ method: 'peer/gotNotification', params: { method: m.method, hasJsonrpc: 'jsonrpc' in m } }); return }
  const { id, method, params } = m
  if (method === 'echo') out({ id, result: { params, hasJsonrpc: 'jsonrpc' in m } })
  else if (method === 'delayed') setTimeout(() => out({ id, result: params.value }), params.ms)
  else if (method === 'fail') out({ id, error: { code: 42, message: 'nope', data: { why: 'test' } } })
  else if (method === 'notifyThenReply') { out({ method: 'peer/event', params: { n: 1 } }); out({ id, result: 'ok' }) }
  else if (method === 'burst') {
    // Two messages in one chunk, then one message fragmented across chunks.
    const a = JSON.stringify({ method: 'peer/event', params: { n: 1 } }) + '\n' + JSON.stringify({ method: 'peer/event', params: { n: 2 } }) + '\n'
    const b = JSON.stringify({ id, result: 'burst-done' }) + '\n'
    process.stdout.write(a + b.slice(0, 5))
    setTimeout(() => process.stdout.write(b.slice(5)), 20)
  }
  else if (method === 'ask') {
    const askId = 'srv-' + id
    waiting.set(askId, (reply) => out({ id, result: reply }))
    out({ id: askId, method: params.method, params: { q: 1 } })
  }
  else if (method === 'die') { process.stderr.write('fatal: something broke\n'); process.exit(7) }
  else if (method === 'sleep') {}
})
`

const clients: JsonRpcStdioClient[] = []
function startPeer(options: Partial<ConstructorParameters<typeof JsonRpcStdioClient>[0]> = {}): JsonRpcStdioClient {
  const client = new JsonRpcStdioClient({ command: process.execPath, args: ['-e', PEER], ...options })
  clients.push(client)
  client.start()
  return client
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()))
})

describe('LineBuffer', () => {
  it('handles partial lines, multiple lines per chunk, CRLF, and blank lines', () => {
    const buf = new LineBuffer()
    expect(buf.push('{"a":')).toEqual([])
    expect(buf.push('1}\n{"b":2}\r\n\n{"c"')).toEqual(['{"a":1}', '{"b":2}'])
    expect(buf.push(':3}\n')).toEqual(['{"c":3}'])
    expect(buf.push('{"tail":true}')).toEqual([])
    expect(buf.flush()).toEqual(['{"tail":true}'])
  })

  it('reassembles multi-byte UTF-8 characters split across chunks', () => {
    const buf = new LineBuffer()
    const bytes = Buffer.from('{"t":"héllo ✓"}\n', 'utf-8')
    const split = bytes.indexOf(0xa9) // middle of "é"
    expect(buf.push(bytes.subarray(0, split))).toEqual([])
    expect(buf.push(bytes.subarray(split))).toEqual(['{"t":"héllo ✓"}'])
  })
})

describe('JsonRpcStdioClient', () => {
  it('correlates responses to requests, out of order, without a jsonrpc field', async () => {
    const client = startPeer()
    const slow = client.request('delayed', { value: 'slow', ms: 60 })
    const fast = client.request('delayed', { value: 'fast', ms: 5 })
    const echoed = client.request<{ params: unknown; hasJsonrpc: boolean }>('echo', { x: 1 })
    expect(await fast).toBe('fast')
    expect(await slow).toBe('slow')
    expect(await echoed).toEqual({ params: { x: 1 }, hasJsonrpc: false })
  })

  it('rejects with JsonRpcError on an error response', async () => {
    const client = startPeer()
    const err = await client.request('fail').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JsonRpcError)
    expect(err).toMatchObject({ code: 42, message: 'nope', data: { why: 'test' } })
  })

  it('times out individual requests and keeps working afterwards', async () => {
    const client = startPeer()
    await expect(client.request('sleep', undefined, { timeoutMs: 50 })).rejects.toBeInstanceOf(JsonRpcTimeoutError)
    expect(await client.request('delayed', { value: 1, ms: 1 })).toBe(1)
  })

  it('dispatches notifications, including several per chunk and fragmented lines', async () => {
    const client = startPeer()
    const seen: unknown[] = []
    client.onNotification((method, params) => seen.push({ method, params }))
    expect(await client.request('notifyThenReply')).toBe('ok')
    expect(await client.request('burst')).toBe('burst-done')
    expect(seen).toEqual([
      { method: 'peer/event', params: { n: 1 } },
      { method: 'peer/event', params: { n: 1 } },
      { method: 'peer/event', params: { n: 2 } }
    ])
  })

  it('sends notifications without an id or jsonrpc field', async () => {
    const client = startPeer()
    const got = new Promise<unknown>((resolve) => client.onNotification((_m, params) => resolve(params)))
    client.notify('initialized')
    expect(await got).toEqual({ method: 'initialized', hasJsonrpc: false })
  })

  it('answers server requests via the handler, and -32601 when unhandled', async () => {
    const client = startPeer()
    client.setRequestHandler((method, params) => (method === 'client/ping' ? { pong: params } : undefined))
    expect(await client.request('ask', { method: 'client/ping' })).toEqual({ id: 'srv-1', result: { pong: { q: 1 } } })
    const unhandled = await client.request<{ error: { code: number } }>('ask', { method: 'client/unknown' })
    expect(unhandled.error.code).toBe(JSONRPC_METHOD_NOT_FOUND)

    client.setRequestHandler(() => {
      throw new JsonRpcError(-32000, 'denied')
    })
    expect(await client.request('ask', { method: 'client/x' })).toMatchObject({ error: { code: -32000, message: 'denied' } })
  })

  it('rejects pending requests with the stderr tail when the process exits', async () => {
    const client = startPeer()
    const exits: JsonRpcProcessError[] = []
    client.onExit((err) => exits.push(err))
    const pending = client.request('sleep')
    await client.request('die').catch(() => {})
    const err = await pending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JsonRpcProcessError)
    expect((err as JsonRpcProcessError).exitCode).toBe(7)
    expect((err as Error).message).toContain('fatal: something broke')
    expect(exits).toHaveLength(1)
    expect(client.alive).toBe(false)
    await expect(client.request('echo')).rejects.toBeInstanceOf(JsonRpcProcessError)
  })

  it('reports a missing executable as a process error', async () => {
    const client = new JsonRpcStdioClient({ command: '/nonexistent/codex-binary' })
    clients.push(client)
    client.start()
    const err = await client.request('initialize').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JsonRpcProcessError)
    expect((err as Error).message).toContain('not found')
  })

  it('dispose() kills the child and rejects in-flight requests', async () => {
    const client = startPeer()
    await client.request('echo')
    const pending = client.request('sleep').catch((e: unknown) => e)
    await client.dispose()
    expect(await pending).toMatchObject({ message: 'client disposed' })
    expect(client.alive).toBe(false)
  })
})
