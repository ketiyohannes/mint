import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'

/**
 * A small JSON-RPC 2.0 client that talks to a child process over stdio using
 * newline-delimited JSON. It is protocol-agnostic; the Codex specifics live in
 * `runtime.ts`.
 *
 * Wire format notes:
 * - One JSON object per line, in both directions.
 * - The `"jsonrpc": "2.0"` field is omitted on send (Codex app-server's dialect)
 *   and ignored on receive.
 * - The child can send requests to us ("server requests"); they are answered
 *   through a single registered handler, or with -32601 when none matches.
 */

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams

export type RequestId = number | string

export const JSONRPC_METHOD_NOT_FOUND = -32601
export const JSONRPC_INTERNAL_ERROR = -32603

/** An error response from the peer, or an error we want to send to the peer. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'JsonRpcError'
  }
}

/** The child process failed to start, exited, or was disposed. */
export class JsonRpcProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null = null,
    readonly signal: NodeJS.Signals | null = null
  ) {
    super(message)
    this.name = 'JsonRpcProcessError'
  }
}

/** A request did not get a response in time. */
export class JsonRpcTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`JSON-RPC request "${method}" timed out after ${timeoutMs} ms`)
    this.name = 'JsonRpcTimeoutError'
  }
}

export type NotificationHandler = (method: string, params: unknown) => void

/**
 * Handles a request initiated by the child. Return the `result` value; throw a
 * `JsonRpcError` to send a specific error response (any other throw becomes
 * -32603). Return `undefined` to signal "not handled" (-32601).
 */
export type ServerRequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>

export interface JsonRpcStdioClientOptions {
  command: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Injectable for tests. Defaults to `child_process.spawn`. */
  spawnImpl?: SpawnFn
  /** Default per-request timeout. 0 disables. Default: 60 s. */
  requestTimeoutMs?: number
  /** Number of trailing stderr lines kept for diagnostics. Default: 20. */
  stderrTailLines?: number
  /** Grace period between SIGTERM and SIGKILL on dispose. Default: 2 s. */
  killGraceMs?: number
  log?: (msg: string) => void
}

export interface RequestOptions {
  /** Overrides the client default. 0 disables the timeout. */
  timeoutMs?: number
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Splits an arbitrary stream of chunks into complete lines. Handles partial
 * lines across chunks, multiple lines per chunk, `\r\n`, and multi-byte UTF-8
 * characters split across chunk boundaries.
 */
export class LineBuffer {
  private buffer = ''
  private readonly decoder = new TextDecoder('utf-8')

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    const lines: string[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      let line = this.buffer.slice(0, newline)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim() !== '') lines.push(line)
      newline = this.buffer.indexOf('\n')
    }
    return lines
  }

  /** Returns whatever is left once the stream has ended. */
  flush(): string[] {
    this.buffer += this.decoder.decode()
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest === '' ? [] : [rest]
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g

/** Codex logs with ANSI colors; strip them so error messages stay readable. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'number' || typeof value === 'string'
}

export class JsonRpcStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<RequestId, PendingRequest>()
  private readonly notificationHandlers = new Set<NotificationHandler>()
  private readonly exitHandlers = new Set<(err: JsonRpcProcessError) => void>()
  private requestHandler: ServerRequestHandler | null = null
  private readonly stdoutLines = new LineBuffer()
  private readonly stderrLines = new LineBuffer()
  private readonly stderrTail: string[] = []
  private exitError: JsonRpcProcessError | null = null
  private exitPromise: Promise<void> | null = null

  private readonly requestTimeoutMs: number
  private readonly stderrTailLines: number
  private readonly killGraceMs: number
  private readonly log: (msg: string) => void

  constructor(private readonly options: JsonRpcStdioClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000
    this.stderrTailLines = options.stderrTailLines ?? 20
    this.killGraceMs = options.killGraceMs ?? 2_000
    this.log = options.log ?? (() => {})
  }

  /** True while the child is running and has not been disposed. */
  get alive(): boolean {
    return this.child !== null && this.exitError === null
  }

  /** The last stderr lines from the child, oldest first. */
  get stderr(): readonly string[] {
    return this.stderrTail
  }

  /** Spawns the child. Spawn failures surface through `onExit` and pending calls. */
  start(): void {
    if (this.child) throw new Error('JsonRpcStdioClient already started')
    const spawnImpl = this.options.spawnImpl ?? (nodeSpawn as SpawnFn)
    const child = spawnImpl(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    } as SpawnOptionsWithoutStdio)
    this.child = child

    let resolveExit!: () => void
    this.exitPromise = new Promise((resolve) => (resolveExit = resolve))

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of this.stdoutLines.push(chunk)) this.handleLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of this.stderrLines.push(chunk)) this.pushStderr(line)
    })
    // Writes after the child died raise EPIPE here; the exit path reports it.
    child.stdin.on('error', (err) => this.log(`stdin error: ${err.message}`))

    child.on('error', (err: NodeJS.ErrnoException) => {
      const reason =
        err.code === 'ENOENT'
          ? `executable not found: ${this.options.command}`
          : `failed to run ${this.options.command}: ${err.message}`
      this.handleExit(new JsonRpcProcessError(reason))
      resolveExit()
    })
    child.on('close', (code, signal) => {
      for (const line of this.stdoutLines.flush()) this.handleLine(line)
      for (const line of this.stderrLines.flush()) this.pushStderr(line)
      const how = signal ? `signal ${signal}` : `code ${code}`
      this.handleExit(new JsonRpcProcessError(this.withStderr(`process exited with ${how}`), code, signal))
      resolveExit()
    })
  }

  request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError)
    if (!this.child) return Promise.reject(new JsonRpcProcessError('process not started'))

    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: null
      }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new JsonRpcTimeoutError(method, timeoutMs))
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      this.send(params === undefined ? { id, method } : { id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.alive) return
    this.send(params === undefined ? { method } : { method, params })
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onExit(handler: (err: JsonRpcProcessError) => void): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  setRequestHandler(handler: ServerRequestHandler | null): void {
    this.requestHandler = handler
  }

  /**
   * Stops the child: closes stdin, sends SIGTERM, then SIGKILL after a grace
   * period. Pending requests are rejected immediately.
   */
  async dispose(): Promise<void> {
    const child = this.child
    if (!child) return
    if (!this.exitError) this.handleExit(new JsonRpcProcessError('client disposed'))
    if (child.exitCode !== null || child.signalCode !== null) return

    child.stdin.end()
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => child.kill('SIGKILL'), this.killGraceMs)
    try {
      await this.exitPromise
    } finally {
      clearTimeout(killTimer)
    }
  }

  // -------------------------------------------------------------------------

  private send(message: Record<string, unknown>): void {
    if (!this.child || this.exitError) return
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.log(`ignoring non-JSON stdout line: ${line.slice(0, 200)}`)
      return
    }
    if (!isRecord(message)) {
      this.log(`ignoring non-object message: ${line.slice(0, 200)}`)
      return
    }

    const { id, method } = message
    if (typeof method === 'string' && isRequestId(id)) {
      void this.handleServerRequest(id, method, message.params)
    } else if (typeof method === 'string') {
      for (const handler of this.notificationHandlers) {
        try {
          handler(method, message.params)
        } catch (err) {
          this.log(`notification handler for ${method} threw: ${String(err)}`)
        }
      }
    } else if (isRequestId(id)) {
      this.handleResponse(id, message)
    } else {
      this.log(`ignoring unrecognized message: ${line.slice(0, 200)}`)
    }
  }

  private handleResponse(id: RequestId, message: Record<string, unknown>): void {
    const entry = this.pending.get(id)
    if (!entry) return // Late response after a timeout.
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)

    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : JSONRPC_INTERNAL_ERROR
      const text = typeof message.error.message === 'string' ? message.error.message : 'Unknown error'
      entry.reject(new JsonRpcError(code, text, message.error.data))
    } else {
      entry.resolve(message.result)
    }
  }

  private async handleServerRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    try {
      const result = this.requestHandler ? await this.requestHandler(method, params) : undefined
      if (result === undefined) {
        this.send({ id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Method not supported: ${method}` } })
      } else {
        this.send({ id, result })
      }
    } catch (err) {
      const error =
        err instanceof JsonRpcError
          ? { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) }
          : { code: JSONRPC_INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) }
      this.send({ id, error })
    }
  }

  private handleExit(err: JsonRpcProcessError): void {
    if (this.exitError) return
    this.exitError = err
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
      this.pending.delete(id)
    }
    for (const handler of this.exitHandlers) {
      try {
        handler(err)
      } catch (handlerErr) {
        this.log(`exit handler threw: ${String(handlerErr)}`)
      }
    }
  }

  private pushStderr(line: string): void {
    this.stderrTail.push(stripAnsi(line))
    if (this.stderrTail.length > this.stderrTailLines) this.stderrTail.shift()
  }

  private withStderr(message: string): string {
    if (this.stderrTail.length === 0) return message
    return `${message}\n${this.stderrTail.join('\n')}`
  }
}
