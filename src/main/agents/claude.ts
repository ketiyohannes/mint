import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { query, type HookCallback, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { isDomainAllowed } from '../sources'
import { AgentError, type AgentRuntime, type AgentTurnRequest, type AgentTurnResult, type ProviderCheck } from './types'

export interface ClaudeRuntimeOptions {
  model?: string
  /** Optional API key; when absent the SDK uses the local Claude login. */
  apiKey?: string | null
  log?: (msg: string) => void
}

const READ_TOOLS = ['Read', 'Grep', 'Glob']
const WEB_TOOLS = ['WebSearch', 'WebFetch']
/** The SDK's own tool for returning `outputFormat` answers. */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput'

/**
 * AgentRuntime backed by the Claude Agent SDK. mint controls every turn from
 * the outside:
 *  - the tool surface is an explicit allowlist (no Bash, no writes);
 *  - a PreToolUse hook keeps file reads inside the class folder and web calls
 *    inside the class's trusted domains;
 *  - the user's own Claude Code settings, hooks and CLAUDE.md are not loaded.
 */
export class ClaudeRuntime implements AgentRuntime {
  readonly id = 'claude' as const

  constructor(private readonly opts: ClaudeRuntimeOptions = {}) {}

  async run(req: AgentTurnRequest): Promise<AgentTurnResult> {
    if (req.signal?.aborted) throw new AgentError('Cancelled', 'aborted')
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    req.signal?.addEventListener('abort', onAbort, { once: true })

    const tools = [...(req.readFiles ? READ_TOOLS : []), ...(req.web ? WEB_TOOLS : [])]
    const stderr: string[] = []
    const options: Options = {
      cwd: req.cwd,
      systemPrompt: req.system,
      tools,
      allowedTools: req.schema ? [...tools, STRUCTURED_OUTPUT_TOOL] : tools,
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: false,
      includePartialMessages: Boolean(req.onDelta),
      maxTurns: req.maxTurns ?? (tools.length ? 16 : 4),
      abortController: abort,
      hooks: { PreToolUse: [{ hooks: [this.guard(req)] }] },
      env: this.env(),
      stderr: (data) => {
        stderr.push(data)
        if (stderr.length > 40) stderr.shift()
      }
    }
    const bundled = bundledClaudeBinary()
    if (bundled) options.pathToClaudeCodeExecutable = bundled
    if (this.opts.model) options.model = this.opts.model
    if (req.effort) options.effort = req.effort
    if (req.schema) options.outputFormat = { type: 'json_schema', schema: req.schema }

    let finalText = ''
    let streamed = ''
    try {
      for await (const msg of query({ prompt: req.prompt, options })) {
        const delta = textDelta(msg)
        if (delta && req.onDelta) {
          streamed += delta
          req.onDelta(delta)
        }
        if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
          const text = msg.message.content
            .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
          if (text) finalText = text
        }
        if (msg.type === 'result') {
          if (msg.subtype === 'success' && !msg.is_error) {
            const text = msg.result || finalText || streamed
            return { text, structured: req.schema ? (msg.structured_output ?? parseJsonLoose(text)) : undefined }
          }
          const errors = msg.subtype === 'success' ? [msg.result] : msg.errors
          throw classify(errors.join('; ') || msg.subtype, stderr)
        }
      }
      throw classify('The agent ended without a result.', stderr)
    } catch (err) {
      if (abort.signal.aborted) throw new AgentError('Cancelled', 'aborted')
      if (err instanceof AgentError) throw err
      throw classify(err instanceof Error ? err.message : String(err), stderr)
    } finally {
      req.signal?.removeEventListener('abort', onAbort)
    }
  }

  async check(): Promise<ProviderCheck> {
    // Start a session in streaming-input mode (no prompt is sent, so no model
    // turn runs), read the account, then close.
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    async function* idle(): AsyncGenerator<SDKUserMessage> {
      await hold
    }
    const q = query({
      prompt: idle(),
      options: {
        settingSources: [],
        persistSession: false,
        tools: [],
        env: this.env(),
        ...(bundledClaudeBinary() ? { pathToClaudeCodeExecutable: bundledClaudeBinary() } : {}),
        ...(this.opts.model ? { model: this.opts.model } : {})
      }
    })
    try {
      const info = await withTimeout(q.accountInfo(), 30_000, 'Timed out starting the Claude agent.')
      const who = info.email ? ` as ${info.email}` : ''
      const how = info.apiKeySource ? `API key (${info.apiKeySource})` : info.subscriptionType ? `${info.subscriptionType} login` : 'local login'
      if (!info.email && !info.apiKeySource && !info.tokenSource && !info.apiProvider) {
        return { ok: false, message: 'Claude is installed but not signed in. Add an Anthropic API key, or run `claude` in a terminal and log in.' }
      }
      return { ok: true, message: `Claude Agent SDK ready${who} via ${how}.` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
      release()
      q.close()
    }
  }

  async dispose(): Promise<void> {
    // Each turn owns its own process; nothing to clean up.
  }

  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'mint/0.1.0' }
    if (this.opts.apiKey) env.ANTHROPIC_API_KEY = this.opts.apiKey
    return env
  }

  /** Enforce the class-folder and trusted-domain boundaries on every tool call. */
  private guard(req: AgentTurnRequest): HookCallback {
    const root = resolve(req.cwd)
    const deny = (reason: string) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason }
    })
    return async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {}
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
      const name = input.tool_name
      if (name === STRUCTURED_OUTPUT_TOOL) return req.schema ? {} : deny('No structured answer is expected for this turn.')
      if (READ_TOOLS.includes(name)) {
        if (!req.readFiles) return deny('File access is disabled for this turn.')
        for (const key of ['file_path', 'path']) {
          const value = toolInput[key]
          if (typeof value !== 'string' || !value) continue
          const target = isAbsolute(value) ? resolve(value) : resolve(root, value)
          const rel = relative(root, target)
          if (rel.startsWith('..') || isAbsolute(rel)) return deny('Only files inside this class folder can be read.')
        }
        // Glob patterns (Glob's pattern, Grep's glob) must not reach outside the folder either.
        for (const key of ['pattern', 'glob']) {
          if (name === 'Grep' && key === 'pattern') continue // Grep's pattern is a regex, not a path
          const value = toolInput[key]
          if (typeof value !== 'string' || !value) continue
          if (value.split(/[\\/]/).includes('..')) return deny('Search patterns must stay inside this class folder.')
          if (isAbsolute(value)) {
            const rel = relative(root, resolve(value.replace(/[*?[{].*$/, '') || '/'))
            if (rel.startsWith('..') || isAbsolute(rel)) return deny('Only files inside this class folder can be searched.')
          }
        }
        return {}
      }
      if (name === 'WebFetch') {
        const url = typeof toolInput.url === 'string' ? toolInput.url : ''
        if (!req.web || !isDomainAllowed(url, req.web.allowedDomains)) return deny(`Only these trusted domains may be fetched: ${req.web?.allowedDomains.join(', ') ?? 'none'}.`)
        return {}
      }
      if (name === 'WebSearch') {
        if (!req.web) return deny('Web search is disabled for this turn.')
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            updatedInput: { ...toolInput, allowed_domains: req.web.allowedDomains, blocked_domains: undefined }
          }
        }
      }
      return deny(`The ${name} tool is not available in mint.`)
    }
  }
}

function textDelta(msg: SDKMessage): string | null {
  if (msg.type !== 'stream_event' || msg.parent_tool_use_id !== null) return null
  const ev = msg.event
  if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') return ev.delta.text
  return null
}

function classify(message: string, stderr: string[]): AgentError {
  const detail = `${message} ${stderr.join(' ')}`.toLowerCase()
  if (/(api key|apikey|\/login|log in|not logged|unauthori[sz]ed|401|authentication|credit balance)/.test(detail)) {
    return new AgentError('Claude could not authenticate. Add an Anthropic API key in Settings, or run `claude` in a terminal and log in.', 'auth')
  }
  if (/(enoent|spawn|not found)/.test(detail)) return new AgentError('The Claude agent could not be started on this machine.', 'unavailable')
  if (/structured_output|structured output/.test(detail)) return new AgentError('The tutor could not produce a valid answer. Please try again.', 'invalid-output')
  return new AgentError(message.slice(0, 400) || 'The Claude agent failed.', 'failed')
}

/** Accept raw JSON or JSON wrapped in a code fence. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const body = fenced ? fenced[1] : trimmed
  try {
    return JSON.parse(body)
  } catch {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1))
      } catch {
        /* fall through */
      }
    }
    return undefined
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolvePromise(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/**
 * In a packaged app the SDK's platform binary lives inside app.asar, which a
 * process cannot be spawned from; electron-builder unpacks it next to the
 * archive (asarUnpack). Point the SDK there. In development the SDK finds its
 * binary itself, so this returns undefined.
 */
let bundledPath: string | null | undefined
function bundledClaudeBinary(): string | undefined {
  if (bundledPath !== undefined) return bundledPath ?? undefined
  bundledPath = null
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    if (!pkg.includes(`app.asar${sep}`)) return undefined
    const bin = join(dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    if (existsSync(bin)) bundledPath = bin
  } catch {
    // Not packaged for this platform: the SDK falls back to its own lookup.
  }
  return bundledPath ?? undefined
}
