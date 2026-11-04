import type { ModelOption, ProviderId } from '@shared/types'

/**
 * One agent turn, run by a harness (Claude Agent SDK or Codex app-server).
 *
 * mint never asks a harness to remember anything between turns: every turn is
 * self-contained (system + prompt carry all needed context), and every result
 * that changes learner state is validated by code before it is stored.
 */
export interface AgentTurnRequest {
  /** Short machine name of the job, used for logs and for the demo runtime. */
  purpose: string
  /** Developer/system instructions for this turn. */
  system: string
  /** User-visible prompt for this turn. */
  prompt: string
  /** Working directory: the class folder. Built-in read tools are scoped here. */
  cwd: string
  /** Allow read-only file tools (Read/Grep/Glob or Codex read-only shell) inside cwd. */
  readFiles: boolean
  /** Enable web search/fetch restricted to these domains. Omit to disable the web. */
  web?: { allowedDomains: string[] }
  /** JSON schema for a structured final answer. */
  schema?: Record<string, unknown>
  /** Streaming text callback (assistant text only). */
  onDelta?: (text: string) => void
  signal?: AbortSignal
  effort?: 'low' | 'medium' | 'high'
  /** Upper bound on agent loop turns. */
  maxTurns?: number
  /**
   * Deterministic answer used only by the offline demo runtime. Jobs provide
   * it so the app is fully usable (and testable) without any model access.
   */
  demo?: () => DemoAnswer | Promise<DemoAnswer>
}

export interface DemoAnswer {
  text?: string
  structured?: unknown
}

export interface AgentTurnResult {
  /** Final assistant text (for structured turns this may be the JSON text). */
  text: string
  /** Parsed structured output when `schema` was supplied. */
  structured?: unknown
}

export interface ProviderCheck {
  ok: boolean
  message: string
}

export interface AgentRuntime {
  readonly id: ProviderId
  run(req: AgentTurnRequest): Promise<AgentTurnResult>
  check(): Promise<ProviderCheck>
  /** The models this harness offers (empty when it has no choice of model). */
  listModels(): Promise<ModelOption[]>
  dispose(): Promise<void>
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly kind: 'aborted' | 'auth' | 'unavailable' | 'invalid-output' | 'failed' = 'failed'
  ) {
    super(message)
    this.name = 'AgentError'
  }
}
