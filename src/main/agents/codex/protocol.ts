/**
 * Minimal hand-copied subset of the Codex app-server protocol types.
 *
 * Source: `codex app-server generate-ts --experimental` for codex-cli 0.163.0.
 * Only the shapes mint actually sends or reads are kept here; everything else
 * is treated as opaque JSON. When upgrading Codex, regenerate the schema and
 * diff these definitions against it.
 */

export type JsonValue = number | string | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined }

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface ClientInfo {
  name: string
  title: string | null
  version: string
}

export interface InitializeCapabilities {
  /** Opt into receiving experimental API methods and fields. */
  experimentalApi: boolean
  /** Opt into `attestation/generate` requests. */
  requestAttestation: boolean
  optOutNotificationMethods?: string[] | null
}

export interface InitializeParams {
  clientInfo: ClientInfo
  capabilities: InitializeCapabilities | null
}

export interface InitializeResponse {
  userAgent?: string
  codexHome?: string
}

// ---------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------

export type PlanType = string

export type Account = { type: 'apiKey' } | { type: 'chatgpt'; email: string | null; planType: PlanType } | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean }

export interface GetAccountParams {
  refreshToken?: boolean
}

export interface GetAccountResponse {
  account: Account | null
  requiresOpenaiAuth: boolean
}

// ---------------------------------------------------------------------------
// threads and turns
// ---------------------------------------------------------------------------

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type AskForApproval = 'untrusted' | 'on-request' | 'never'

export type WebSearchMode = 'disabled' | 'cached' | 'indexed' | 'live'

export interface WebSearchToolConfig {
  context_size?: 'low' | 'medium' | 'high'
  allowed_domains: string[]
}

/**
 * Subset of the `config` override map accepted by `thread/start` (keys are
 * config.toml keys, snake_case).
 */
export interface ThreadConfigOverrides {
  web_search: WebSearchMode
  /** Omit rather than null: codex 0.163.0 rejects `web_search: null` here. */
  tools?: { web_search: WebSearchToolConfig }
}

export interface ThreadStartParams {
  model?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  config?: ThreadConfigOverrides | null
  baseInstructions?: string | null
  developerInstructions?: string | null
  ephemeral?: boolean | null
}

export interface Thread {
  id: string
}

export interface ThreadStartResponse {
  thread: Thread
  model: string
}

export interface ThreadUnsubscribeParams {
  threadId: string
}

export interface TextElement {
  [key: string]: JsonValue | undefined
}

export type UserInput = { type: 'text'; text: string; text_elements: TextElement[] }

/** Codex accepts any model-supported effort string (e.g. low/medium/high/xhigh). */
export type ReasoningEffort = string

export interface TurnStartParams {
  threadId: string
  input: UserInput[]
  effort?: ReasoningEffort | null
  outputSchema?: JsonValue | null
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

/**
 * Either a well-known string code (e.g. "unauthorized", "usageLimitExceeded")
 * or an object variant such as `{ httpConnectionFailed: { httpStatusCode } }`.
 */
export type CodexErrorInfo = string | { [key: string]: unknown }

export interface TurnError {
  message: string
  codexErrorInfo: CodexErrorInfo | null
  additionalDetails: string | null
}

export type MessagePhase = 'commentary' | 'partial_answer' | 'final_answer'

export interface AgentMessageItem {
  type: 'agentMessage'
  id: string
  text: string
  /** Providers do not emit this consistently; null means "phase unknown". */
  phase: MessagePhase | null
}

/** Only `agentMessage` is read by mint; every other item variant is opaque. */
export type ThreadItem = AgentMessageItem | { type: string; id: string }

export function isAgentMessageItem(item: ThreadItem | null | undefined): item is AgentMessageItem {
  return item?.type === 'agentMessage' && typeof (item as { text?: unknown }).text === 'string'
}

export interface Turn {
  id: string
  items: ThreadItem[]
  status: TurnStatus
  error: TurnError | null
}

export interface TurnStartResponse {
  turn: Turn
}

export interface TurnInterruptParams {
  threadId: string
  turnId: string
}

// ---------------------------------------------------------------------------
// server -> client notifications
// ---------------------------------------------------------------------------

export interface TurnStartedNotification {
  threadId: string
  turn: Turn
}

export interface TurnCompletedNotification {
  threadId: string
  turn: Turn
}

export interface ItemStartedNotification {
  item: ThreadItem
  threadId: string
  turnId: string
}

export interface ItemCompletedNotification {
  item: ThreadItem
  threadId: string
  turnId: string
}

export interface AgentMessageDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

/** Method `error`: emitted for turn errors, possibly while the server retries. */
export interface ErrorNotification {
  error: TurnError
  willRetry: boolean
  threadId: string
  turnId: string
}

// ---------------------------------------------------------------------------
// server -> client requests (and the responses mint sends back)
// ---------------------------------------------------------------------------

export type CommandExecutionApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision
}

export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
export interface FileChangeRequestApprovalResponse {
  decision: FileChangeApprovalDecision
}

/** Granting an empty profile grants nothing (the protocol has no explicit "deny"). */
export interface PermissionsRequestApprovalResponse {
  permissions: Record<string, never>
  scope: 'turn' | 'session'
}

/** Legacy v1 approval decision (`execCommandApproval` / `applyPatchApproval`). */
export type ReviewDecision = 'approved' | 'approved_for_session' | { denied: { rejection: string } } | 'abort'
export interface LegacyApprovalResponse {
  decision: ReviewDecision
}

export type DynamicToolCallOutputContentItem = { type: 'inputText'; text: string }
export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[]
  success: boolean
}

export interface McpServerElicitationRequestResponse {
  action: 'accept' | 'decline' | 'cancel'
  content: JsonValue | null
  _meta: JsonValue | null
}

export interface ToolRequestUserInputResponse {
  answers: { [questionId: string]: { answers: string[] } | undefined }
}

export interface CurrentTimeReadResponse {
  /** Current time as whole Unix seconds. */
  currentTimeAt: number
}

/** Well-known method names used by mint. */
export const Method = {
  initialize: 'initialize',
  initialized: 'initialized',
  accountRead: 'account/read',
  modelList: 'model/list',
  threadStart: 'thread/start',
  threadUnsubscribe: 'thread/unsubscribe',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',

  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  error: 'error',

  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  legacyExecApproval: 'execCommandApproval',
  legacyPatchApproval: 'applyPatchApproval',
  toolCall: 'item/tool/call',
  toolRequestUserInput: 'item/tool/requestUserInput',
  mcpElicitation: 'mcpServer/elicitation/request',
  currentTimeRead: 'currentTime/read'
} as const

/** model/list (v2): the models this Codex account can use, paginated. */
export interface ModelListResponse {
  data: Array<{ id: string; model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean }>
  nextCursor: string | null
}
