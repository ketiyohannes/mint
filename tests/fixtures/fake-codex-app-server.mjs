#!/usr/bin/env node
/**
 * A tiny stand-in for `codex app-server` (codex-cli 0.163.0 protocol subset).
 * Speaks newline-delimited JSON-RPC without the "jsonrpc" field.
 *
 * Behavior is driven by keywords in the turn prompt:
 *   NEED_APPROVAL  send item/commandExecution/requestApproval and echo the decision
 *   FAIL           complete the turn with status "failed"
 *   AUTHFAIL       fail the turn with codexErrorInfo "unauthorized"
 *   HANG           never finish until turn/interrupt
 *   CRASH          exit the process mid-turn
 *   SLOW           pause between deltas (for interleaving tests)
 *   COMMENTARY     emit a commentary message before the final answer
 *   ECHO_PARAMS    final answer is the JSON of the thread/start + turn/start params
 *   BADJSON        with an outputSchema, reply with non-JSON text
 *   FENCED         with an outputSchema, wrap the JSON in a ``` fence
 * Env: FAKE_CODEX_LOGGED_OUT=1 makes account/read report no account.
 *
 * The first argument is ignored when it is "app-server".
 */
import { createInterface } from 'node:readline'

const threads = new Map() // threadId -> thread/start params
const turns = new Map() // turnId -> { threadId, finish }
const pendingClientResponses = new Map() // our request id -> resolve
let nextId = 1
let nextServerRequestId = 1000

// All writes go through one queue so a fragmented message is never interleaved
// with output from another concurrent turn.
let writeQueue = Promise.resolve()

/** Writes messages; with `split`, deliberately fragments them across writes. */
function send(messages, { split = false } = {}) {
  const text = messages.map((m) => JSON.stringify(m) + '\n').join('')
  writeQueue = writeQueue.then(async () => {
    if (!split) {
      process.stdout.write(text)
      return
    }
    const cut = Math.max(1, Math.floor(text.length / 3))
    process.stdout.write(text.slice(0, cut))
    await sleep(5)
    process.stdout.write(text.slice(cut))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function serverRequest(method, params) {
  const id = nextServerRequestId++
  return new Promise((resolve) => {
    pendingClientResponses.set(id, resolve)
    send([{ id, method, params }])
  })
}

function turnObject(id, status, error = null, items = []) {
  return { id, rootTurnId: id, items, itemsView: 'summary', status, error, startedAt: null, completedAt: null, durationMs: null }
}

async function runTurn(threadId, turnId, params) {
  const prompt = params.input.map((i) => i.text ?? '').join('\n')
  let finished = false
  const complete = (status, error = null, items = []) => {
    if (finished) return
    finished = true
    turns.delete(turnId)
    send([{ method: 'turn/completed', params: { threadId, turn: turnObject(turnId, status, error, items) } }])
  }
  turns.set(turnId, { threadId, interrupt: () => complete('interrupted') })

  send([{ method: 'turn/started', params: { threadId, turn: turnObject(turnId, 'inProgress') } }])
  await sleep(5)

  if (prompt.includes('CRASH')) {
    process.stderr.write('\u001b[31mERROR\u001b[0m fake codex: simulated crash\n')
    writeQueue.then(() => setTimeout(() => process.exit(3), 10))
    return
  }
  if (prompt.includes('HANG')) return
  if (prompt.includes('AUTHFAIL')) {
    complete('failed', { message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'unauthorized', additionalDetails: null })
    return
  }
  if (prompt.includes('FAIL')) {
    const error = { message: 'model exploded', codexErrorInfo: 'other', additionalDetails: null }
    send([{ method: 'error', params: { error, willRetry: false, threadId, turnId } }])
    complete('failed', error)
    return
  }

  let decision = null
  if (prompt.includes('NEED_APPROVAL')) {
    const response = await serverRequest('item/commandExecution/requestApproval', {
      kind: 'command',
      threadId,
      turnId,
      itemId: 'cmd-1',
      startedAtMs: Date.now(),
      environmentId: null,
      command: 'rm -rf /tmp/whatever'
    })
    decision = response.result?.decision ?? `error:${response.error?.code}`
  }

  if (prompt.includes('COMMENTARY')) {
    const item = { type: 'agentMessage', id: `${turnId}-c`, text: 'Thinking out loud.', phase: 'commentary', memoryCitation: null }
    send([
      { method: 'item/started', params: { item: { ...item, text: '' }, threadId, turnId } },
      { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: item.id, delta: item.text } },
      { method: 'item/completed', params: { item, threadId, turnId } }
    ])
  }

  let answer
  if (prompt.includes('ECHO_PARAMS')) {
    answer = JSON.stringify({ thread: threads.get(threadId), turn: params })
  } else if (params.outputSchema) {
    const json = JSON.stringify({ answer: prompt.replace(/\s+/g, ' ').trim() })
    answer = prompt.includes('BADJSON') ? 'Sorry, here is prose.' : prompt.includes('FENCED') ? '```json\n' + json + '\n```' : json
  } else {
    answer = `Hello from fake codex: ${prompt}`
    if (decision !== null) answer += ` decision=${decision}`
  }

  // Stream in three chunks; the first batch is fragmented across writes.
  const itemId = `${turnId}-m`
  const third = Math.ceil(answer.length / 3)
  const chunks = [answer.slice(0, third), answer.slice(third, 2 * third), answer.slice(2 * third)].filter(Boolean)
  // Reasoning deltas must never reach onDelta.
  send([{ method: 'item/reasoning/textDelta', params: { threadId, turnId, itemId: 'r1', delta: 'SECRET_REASONING' } }])
  const item = { type: 'agentMessage', id: itemId, text: answer, phase: 'final_answer', memoryCitation: null }
  send([{ method: 'item/started', params: { item: { ...item, text: '' }, threadId, turnId } }])
  for (const [index, delta] of chunks.entries()) {
    if (finished) return
    send([{ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta } }], { split: index === 0 })
    await sleep(prompt.includes('SLOW') ? 30 : 10)
  }
  if (finished) return
  send([{ method: 'item/completed', params: { item, threadId, turnId } }])
  complete('completed', null, [item])
}

function handleRequest({ id, method, params }) {
  switch (method) {
    case 'initialize':
      send([{ id, result: { userAgent: 'fake-codex/0.163.0', codexHome: '/tmp/fake', platformFamily: 'unix', platformOs: 'macos' } }])
      return
    case 'account/read':
      send([
        {
          id,
          result:
            process.env.FAKE_CODEX_LOGGED_OUT === '1'
              ? { account: null, requiresOpenaiAuth: true, workspaceRouting: null }
              : { account: { type: 'chatgpt', email: 'learner@example.com', planType: 'plus' }, requiresOpenaiAuth: true, workspaceRouting: null }
        }
      ])
      return
    case 'thread/start': {
      const threadId = `thread-${nextId++}`
      threads.set(threadId, params)
      send([{ id, result: { thread: { id: threadId, ephemeral: true, turns: [] }, model: params.model ?? 'fake-model', cwd: params.cwd } }])
      return
    }
    case 'thread/unsubscribe':
      threads.delete(params.threadId)
      send([{ id, result: { status: 'unsubscribed' } }])
      return
    case 'turn/start': {
      if (!threads.has(params.threadId)) {
        send([{ id, error: { code: -32600, message: `thread not found: ${params.threadId}` } }])
        return
      }
      const turnId = `turn-${nextId++}`
      send([{ id, result: { turn: turnObject(turnId, 'inProgress') } }])
      void runTurn(params.threadId, turnId, params)
      return
    }
    case 'turn/interrupt': {
      send([{ id, result: {} }])
      turns.get(params.turnId)?.interrupt()
      return
    }
    default:
      send([{ id, error: { code: -32601, message: `unknown method ${method}` } }])
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if ('jsonrpc' in message) {
    process.stderr.write('fake codex: unexpected jsonrpc field\n')
    process.exit(2)
  }
  if (message.method && message.id !== undefined) handleRequest(message)
  else if (message.method)
    return // notifications such as "initialized"
  else pendingClientResponses.get(message.id)?.(message)
})
process.stdin.on('end', () => process.exit(0))
