import type { ModelOption } from '@shared/types'
import { accessSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { AgentError, type AgentRuntime, type AgentTurnRequest, type AgentTurnResult, type ProviderCheck } from '../types'
import { JsonRpcError, JsonRpcProcessError, JsonRpcStdioClient, JsonRpcTimeoutError, type SpawnFn } from './jsonrpc'
import {
  Method,
  isAgentMessageItem,
  type AgentMessageDeltaNotification,
  type CommandExecutionRequestApprovalResponse,
  type CurrentTimeReadResponse,
  type DynamicToolCallResponse,
  type ErrorNotification,
  type FileChangeRequestApprovalResponse,
  type GetAccountResponse,
  type InitializeParams,
  type ItemCompletedNotification,
  type JsonValue,
  type LegacyApprovalResponse,
  type McpServerElicitationRequestResponse,
  type ModelListResponse,
  type PermissionsRequestApprovalResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ToolRequestUserInputResponse,
  type Turn,
  type TurnCompletedNotification,
  type TurnError,
  type TurnStartParams,
  type TurnStartResponse
} from './protocol'

export interface CodexRuntimeOptions {
  /** Explicit path to the `codex` binary. Otherwise PATH and common install locations are searched. */
  codexPath?: string
  /** Model override. Empty/undefined uses the Codex default model. */
  model?: string
  /** The running mint version, reported to the app-server as the client version. */
  clientVersion?: string
  /** Injectable process spawner (tests run a fake app-server through it). */
  spawnImpl?: SpawnFn
  log?: (msg: string) => void
  /** Overall budget for one turn before it is interrupted. Default: 6 minutes. */
  turnTimeoutMs?: number
  /** Timeout for individual control requests (initialize, thread/start, ...). Default: 60 s. */
  requestTimeoutMs?: number
}

const DEFAULT_TURN_TIMEOUT_MS = 6 * 60_000
const LOGIN_HINT = 'Codex is not logged in. Run `codex login` in a terminal, then try again.'

/** Locations checked after PATH. Electron apps launched from Finder get a minimal PATH. */
function fallbackCodexLocations(): string[] {
  return [join(homedir(), '.local', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(homedir(), '.npm-global', 'bin', 'codex')]
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolves the codex binary: explicit path, then PATH, then common install locations. */
export function resolveCodexPath(explicit?: string, envPath: string | undefined = process.env.PATH): string | null {
  if (explicit) return explicit
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']
  for (const dir of (envPath ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  return fallbackCodexLocations().find(isExecutable) ?? null
}

/**
 * The environment for the app-server. Codex runs shell commands itself, so it
 * needs a usable PATH even when mint was launched with a minimal one.
 */
function childEnv(codexPath: string): NodeJS.ProcessEnv {
  const extra = [dirname(codexPath), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const merged = [...current, ...extra.filter((dir) => !current.includes(dir))]
  return { ...process.env, PATH: merged.join(delimiter) }
}

/**
 * Parses a structured final answer. Tolerates a surrounding ``` fence and
 * stray prose around a single top-level JSON value.
 */
export function parseStructuredOutput(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed)
  const body = fenced ? fenced[1].trim() : trimmed
  try {
    return JSON.parse(body)
  } catch {
    // Fall back to the outermost object/array span.
    const start = body.search(/[[{]/)
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
    if (start !== -1 && end > start) return JSON.parse(body.slice(start, end + 1))
    throw new SyntaxError('No JSON value found')
  }
}

function isAuthFailure(error: { message?: string; codexErrorInfo?: unknown } | null | undefined): boolean {
  if (!error) return false
  if (error.codexErrorInfo === 'unauthorized') return true
  return /not logged in|unauthori[sz]ed|\b401\b|login required|codex login|authentication/i.test(error.message ?? '')
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Converts transport/protocol failures to the AgentError vocabulary. */
function toAgentError(err: unknown, context: string): AgentError {
  if (err instanceof AgentError) return err
  const message = errorMessage(err)
  if (isAuthFailure({ message })) return new AgentError(LOGIN_HINT, 'auth')
  if (err instanceof JsonRpcProcessError) return new AgentError(`Codex app-server unavailable (${context}): ${message}`, 'unavailable')
  if (err instanceof JsonRpcTimeoutError) return new AgentError(`Codex app-server did not respond (${context}): ${message}`, 'unavailable')
  if (err instanceof JsonRpcError) return new AgentError(`Codex ${context} failed: ${message}`, 'failed')
  return new AgentError(`Codex ${context} failed: ${message}`, 'failed')
}

function turnErrorToAgentError(turn: Turn, fallback: TurnError | null): AgentError {
  const error = turn.error ?? fallback
  if (turn.status === 'interrupted') return new AgentError(error?.message ? `Turn interrupted: ${error.message}` : 'Cancelled', 'aborted')
  if (isAuthFailure(error)) return new AgentError(LOGIN_HINT, 'auth')
  return new AgentError(error?.message ? `Codex turn failed: ${error.message}` : 'Codex turn failed', 'failed')
}

/**
 * The answer is the last `final_answer` agent message (Codex may also emit
 * `commentary` messages); otherwise the last agent message. Items streamed via
 * `item/completed` win; the completed turn's item list is the fallback.
 */
function finalText(turn: Turn, active: ActiveTurn): string {
  if (active.lastFinalAnswer !== null) return active.lastFinalAnswer
  if (active.lastMessage !== null) return active.lastMessage
  const messages = (Array.isArray(turn.items) ? turn.items : []).filter(isAgentMessageItem)
  const final = messages.filter((item) => item.phase === 'final_answer').at(-1) ?? messages.at(-1)
  return final?.text ?? ''
}

/** Policy appended to the caller's system prompt; Codex always has a shell, so tool limits are stated explicitly. */
function developerInstructions(req: AgentTurnRequest): string {
  const rules: string[] = []
  if (req.readFiles) {
    rules.push('You may read files inside the working directory using read-only commands. Never create, modify, or delete files.')
  } else {
    rules.push('Do not run shell commands or use any file tools. Answer only from the information given in this conversation.')
  }
  if (req.web) {
    const domains = req.web.allowedDomains.join(', ')
    rules.push(`Web search is available, restricted to these domains: ${domains}. Do not use or cite any other web source.`)
  } else {
    rules.push('Do not access the web.')
  }
  rules.push('Do not ask the user questions; this turn is non-interactive.')
  return `${req.system.trim()}\n\n# Tool policy\n${rules.map((rule) => `- ${rule}`).join('\n')}`
}

/** Bookkeeping for one in-flight turn, keyed by threadId (one turn per ephemeral thread). */
interface ActiveTurn {
  threadId: string
  turnId: string | null
  onDelta?: (text: string) => void
  /** Item id of the agent message currently streaming, used to separate consecutive messages. */
  streamingItemId: string | null
  streamedAny: boolean
  lastMessage: string | null
  lastFinalAnswer: string | null
  lastError: TurnError | null
  /** Set when an interrupt was requested before `turn/start` returned a turn id. */
  interruptRequested: boolean
  settle: (outcome: { text: string } | { error: AgentError }) => void
}

export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex' as const

  private client: JsonRpcStdioClient | null = null
  private starting: Promise<JsonRpcStdioClient> | null = null
  private authVerified = false
  private disposed = false
  private readonly turns = new Map<string, ActiveTurn>()
  private readonly log: (msg: string) => void
  private readonly turnTimeoutMs: number

  constructor(private readonly options: CodexRuntimeOptions = {}) {
    this.log = options.log ?? (() => {})
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  }

  async run(req: AgentTurnRequest): Promise<AgentTurnResult> {
    if (req.signal?.aborted) throw new AgentError('Cancelled', 'aborted')
    const client = await this.ensureClient()
    await this.verifyAuthOnce(client)
    if (req.signal?.aborted) throw new AgentError('Cancelled', 'aborted')

    const threadParams: ThreadStartParams = {
      cwd: req.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      developerInstructions: developerInstructions(req),
      // The real server rejects `tools.web_search: null` (it must match
      // WebSearchToolConfigInput), so `tools` is only sent when web is on.
      config: req.web ? { web_search: 'live', tools: { web_search: { allowed_domains: req.web.allowedDomains } } } : { web_search: 'disabled' }
    }
    let threadId: string
    try {
      const started = await client.request<ThreadStartResponse>(Method.threadStart, threadParams)
      threadId = started.thread.id
    } catch (err) {
      throw toAgentError(err, 'thread/start')
    }

    try {
      const text = await this.runTurn(client, threadId, req)
      return this.buildResult(text, req)
    } finally {
      // Ephemeral threads are never persisted, but the server keeps them
      // loaded until unsubscribed; release them so a long session doesn't leak.
      if (client.alive) {
        client.request(Method.threadUnsubscribe, { threadId }).catch((err: unknown) => {
          this.log(`codex: thread/unsubscribe failed: ${errorMessage(err)}`)
        })
      }
    }
  }

  async check(): Promise<ProviderCheck> {
    try {
      const client = await this.ensureClient()
      const response = await client.request<GetAccountResponse>(Method.accountRead, { refreshToken: false })
      const account = response.account
      if (!account) {
        return response.requiresOpenaiAuth ? { ok: false, message: LOGIN_HINT } : { ok: true, message: 'Codex app-server ready (no login required)' }
      }
      this.authVerified = true
      const how = account.type === 'chatgpt' ? 'ChatGPT login' : account.type === 'apiKey' ? 'API key' : account.type === 'amazonBedrock' ? 'Amazon Bedrock' : 'signed in'
      return { ok: true, message: `Codex app-server ready (${how})` }
    } catch (err) {
      return { ok: false, message: toAgentError(err, 'startup').message }
    }
  }

  async listModels(): Promise<ModelOption[]> {
    const client = await this.ensureClient()
    const out: ModelOption[] = []
    let cursor: string | null = null
    // Pages are small; stop after a few in case a server keeps returning cursors.
    for (let page = 0; page < 10; page++) {
      const res: ModelListResponse = await client.request<ModelListResponse>(Method.modelList, { cursor, includeHidden: false })
      for (const m of res.data ?? []) if (!m.hidden) out.push({ id: m.model || m.id, label: m.displayName || m.model || m.id, description: m.description ?? '', isDefault: Boolean(m.isDefault) })
      cursor = res.nextCursor
      if (!cursor) break
    }
    return out
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const client = this.client
    this.client = null
    this.starting = null
    for (const turn of this.turns.values()) turn.settle({ error: new AgentError('Codex runtime shut down', 'aborted') })
    this.turns.clear()
    await client?.dispose()
  }

  // -------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------

  /** Starts the turn and resolves with the final agent message text. */
  private runTurn(client: JsonRpcStdioClient, threadId: string, req: AgentTurnRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        const seconds = Math.round(this.turnTimeoutMs / 1000)
        const budget = seconds >= 60 ? `${Math.round((seconds / 60) * 10) / 10} min` : `${seconds} s`
        cancel(new AgentError(`Codex turn timed out after ${budget}`, 'failed'))
      }, this.turnTimeoutMs)

      const onAbort = (): void => cancel(new AgentError('Cancelled', 'aborted'))

      const active: ActiveTurn = {
        threadId,
        turnId: null,
        onDelta: req.onDelta,
        streamingItemId: null,
        streamedAny: false,
        lastMessage: null,
        lastFinalAnswer: null,
        lastError: null,
        interruptRequested: false,
        settle: (outcome) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          req.signal?.removeEventListener('abort', onAbort)
          this.turns.delete(threadId)
          if ('error' in outcome) reject(outcome.error)
          else resolve(outcome.text)
        }
      }

      const cancel = (error: AgentError): void => {
        if (settled) return
        this.interrupt(client, active)
        active.settle({ error })
      }

      this.turns.set(threadId, active)
      req.signal?.addEventListener('abort', onAbort, { once: true })

      const params: TurnStartParams = {
        threadId,
        input: [{ type: 'text', text: req.prompt, text_elements: [] }],
        ...(req.schema ? { outputSchema: req.schema as JsonValue } : {}),
        ...(req.effort ? { effort: req.effort } : {})
      }
      client.request<TurnStartResponse>(Method.turnStart, params).then(
        (response) => {
          active.turnId = response.turn.id
          // Abort raced the turn/start round trip: the turn exists now, stop it.
          if (active.interruptRequested) this.interrupt(client, active)
        },
        (err: unknown) => active.settle({ error: toAgentError(err, 'turn/start') })
      )
    })
  }

  /** Best-effort `turn/interrupt`; deferred until the turn id is known. */
  private interrupt(client: JsonRpcStdioClient, active: ActiveTurn): void {
    if (!active.turnId) {
      active.interruptRequested = true
      return
    }
    active.interruptRequested = false
    if (!client.alive) return
    client.request(Method.turnInterrupt, { threadId: active.threadId, turnId: active.turnId }).catch((err: unknown) => {
      this.log(`codex: turn/interrupt failed: ${errorMessage(err)}`)
    })
  }

  private buildResult(text: string, req: AgentTurnRequest): AgentTurnResult {
    if (!req.schema) return { text }
    try {
      return { text, structured: parseStructuredOutput(text) }
    } catch {
      const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text
      throw new AgentError(`Codex returned invalid structured output: ${preview || '(empty)'}`, 'invalid-output')
    }
  }

  // -------------------------------------------------------------------------
  // Notifications and server requests
  // -------------------------------------------------------------------------

  private handleNotification(method: string, params: unknown): void {
    if (typeof params !== 'object' || params === null) return
    const threadId = (params as { threadId?: unknown }).threadId
    if (typeof threadId !== 'string') return
    const active = this.turns.get(threadId)
    if (!active) return

    switch (method) {
      case Method.agentMessageDelta: {
        const { itemId, delta } = params as AgentMessageDeltaNotification
        if (typeof delta !== 'string' || !active.onDelta) return
        if (active.streamingItemId !== itemId) {
          // Separate consecutive agent messages (e.g. commentary, then the answer).
          if (active.streamedAny) active.onDelta('\n\n')
          active.streamingItemId = itemId
        }
        active.streamedAny = true
        active.onDelta(delta)
        return
      }
      case Method.itemCompleted: {
        const { item } = params as ItemCompletedNotification
        if (!isAgentMessageItem(item)) return
        active.lastMessage = item.text
        if (item.phase === 'final_answer') active.lastFinalAnswer = item.text
        return
      }
      case Method.error: {
        const { error, willRetry } = params as ErrorNotification
        if (error && typeof error.message === 'string') {
          this.log(`codex: turn error${willRetry ? ' (retrying)' : ''}: ${error.message}`)
          if (!willRetry) active.lastError = error
        }
        return
      }
      case Method.turnCompleted: {
        const { turn } = params as TurnCompletedNotification
        if (!turn || typeof turn.status !== 'string') return
        if (turn.status === 'completed') {
          active.settle({ text: finalText(turn, active) })
        } else {
          active.settle({ error: turnErrorToAgentError(turn, active.lastError) })
        }
        return
      }
      default:
        return
    }
  }

  /**
   * mint never grants anything: the thread already runs read-only with
   * `approvalPolicy: never`, so these only arrive if Codex escalates anyway.
   */
  private handleServerRequest(method: string, params: unknown): unknown {
    const threadId = typeof params === 'object' && params !== null ? (params as { threadId?: unknown }).threadId : undefined
    const where = typeof threadId === 'string' ? ` (thread ${threadId})` : ''
    switch (method) {
      case Method.commandApproval:
        this.log(`codex: declined command approval${where}`)
        return { decision: 'decline' } satisfies CommandExecutionRequestApprovalResponse
      case Method.fileChangeApproval:
        this.log(`codex: declined file change approval${where}`)
        return { decision: 'decline' } satisfies FileChangeRequestApprovalResponse
      case Method.permissionsApproval:
        this.log(`codex: denied permission escalation${where}`)
        return { permissions: {}, scope: 'turn' } satisfies PermissionsRequestApprovalResponse
      case Method.legacyExecApproval:
      case Method.legacyPatchApproval:
        this.log(`codex: denied legacy ${method}${where}`)
        return { decision: { denied: { rejection: 'mint runs Codex read-only; this action is not allowed.' } } } satisfies LegacyApprovalResponse
      case Method.toolCall:
        return { contentItems: [{ type: 'inputText', text: 'Tool not available' }], success: false } satisfies DynamicToolCallResponse
      case Method.mcpElicitation:
        return { action: 'decline', content: null, _meta: null } satisfies McpServerElicitationRequestResponse
      case Method.toolRequestUserInput:
        return { answers: {} } satisfies ToolRequestUserInputResponse
      case Method.currentTimeRead:
        return { currentTimeAt: Math.floor(Date.now() / 1000) } satisfies CurrentTimeReadResponse
      default:
        this.log(`codex: unsupported server request ${method}`)
        return undefined // -> JSON-RPC -32601
    }
  }

  // -------------------------------------------------------------------------
  // Process lifecycle
  // -------------------------------------------------------------------------

  /** Returns a live, initialized client, (re)starting the app-server if needed. */
  private async ensureClient(): Promise<JsonRpcStdioClient> {
    if (this.disposed) throw new AgentError('Codex runtime has been shut down', 'unavailable')
    if (this.client?.alive) return this.client
    if (!this.starting) {
      this.starting = this.startClient().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async startClient(): Promise<JsonRpcStdioClient> {
    const codexPath = resolveCodexPath(this.options.codexPath)
    if (!codexPath) {
      throw new AgentError('Codex CLI not found. Install it (https://github.com/openai/codex) or set its path in settings.', 'unavailable')
    }

    const client = new JsonRpcStdioClient({
      command: codexPath,
      args: ['app-server'],
      env: childEnv(codexPath),
      spawnImpl: this.options.spawnImpl,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 60_000,
      log: this.log
    })
    client.onNotification((method, params) => this.handleNotification(method, params))
    client.setRequestHandler((method, params) => this.handleServerRequest(method, params))
    client.onExit((err) => this.handleClientExit(client, err))

    this.log(`codex: starting ${codexPath} app-server`)
    try {
      // Inside the try: spawn can also fail by throwing, not only through the exit handler.
      client.start()
      const init: InitializeParams = {
        clientInfo: { name: 'mint', title: 'mint', version: this.options.clientVersion || '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false }
      }
      await client.request(Method.initialize, init, { timeoutMs: 30_000 })
      client.notify(Method.initialized)
    } catch (err) {
      await client.dispose()
      throw toAgentError(err, 'initialize')
    }

    if (this.disposed) {
      await client.dispose()
      throw new AgentError('Codex runtime has been shut down', 'unavailable')
    }
    this.client = client
    this.authVerified = false
    return client
  }

  /** Fails fast with a login hint instead of waiting for the model call to 401. */
  private async verifyAuthOnce(client: JsonRpcStdioClient): Promise<void> {
    if (this.authVerified) return
    let response: GetAccountResponse
    try {
      response = await client.request<GetAccountResponse>(Method.accountRead, { refreshToken: false })
    } catch (err) {
      // Not fatal: the turn itself will surface any real auth failure.
      this.log(`codex: account/read failed: ${errorMessage(err)}`)
      return
    }
    if (!response.account && response.requiresOpenaiAuth) throw new AgentError(LOGIN_HINT, 'auth')
    this.authVerified = true
  }

  private handleClientExit(client: JsonRpcStdioClient, err: JsonRpcProcessError): void {
    if (this.client !== client) return
    this.client = null
    if (this.disposed) return
    this.log(`codex: app-server stopped: ${err.message}`)
    const error = new AgentError(`Codex app-server stopped unexpectedly: ${err.message}`, 'unavailable')
    for (const turn of [...this.turns.values()]) turn.settle({ error })
  }
}
