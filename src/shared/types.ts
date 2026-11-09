/**
 * Domain model shared by the main process (which owns all state) and the
 * renderer (which only ever reads snapshots and sends commands).
 *
 * Design rule: "code remembers, models judge". Everything in here is written
 * by deterministic code in the main process. Model output only ever enters
 * these structures after schema validation.
 */

import type { FocusSpec } from './focus'

export type ID = string

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ProviderId = 'claude' | 'codex' | 'demo'

/** A model a harness offers (from the Agent SDK's supportedModels or Codex's model/list). */
export interface ModelOption {
  /** The id passed to the harness. */
  id: string
  label: string
  description: string
  /** The harness's own default. */
  isDefault?: boolean
}
export type ThemePref = 'light' | 'dark' | 'system'
/** Where the open lesson's brief, reading and checks show: docked over the chat, or in the Study tab beside it. */
export type LessonView = 'dock' | 'tab'
/**
 * How the tutor answers questions. teach: explains in depth, in its own words,
 * with the materials as cited reference. coach: the help ladder (least help
 * first, more on request), which fades as the learner shows independence.
 */
export type TutorStyle = 'teach' | 'coach'

export interface Settings {
  provider: ProviderId
  /** Empty string means "use the harness default model". */
  claudeModel: string
  codexModel: string
  /** Default allowlist used when a class builds a curriculum from trusted sources. */
  trustedDomains: string[]
  theme: ThemePref
  lessonView: LessonView
  tutorStyle: TutorStyle
  /** The focus timer's rhythm (block and break lengths). */
  focus: FocusSpec
}

export interface SettingsView extends Settings {
  hasAnthropicKey: boolean
  dataDir: string
}

export type SecretName = 'anthropic'

// ---------------------------------------------------------------------------
// App updates (new releases from GitHub, installed from inside the app)
// ---------------------------------------------------------------------------

export type UpdateState =
  /** Development and test builds never check. */
  | { status: 'disabled'; reason: string }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; checkedAt: string }
  /** `notes`: what changed, as plain text from the release. */
  | { status: 'available'; version: string; notes?: string }
  | { status: 'downloading'; version: string; percent: number }
  /** Downloaded and verified; applied on restart (or when mint quits). */
  | { status: 'ready'; version: string; notes?: string }
  | { status: 'error'; message: string }

export interface UpdateStatus {
  currentVersion: string
  state: UpdateState
}

// ---------------------------------------------------------------------------
// Class (one learning project; mirrors a /teach workspace)
// ---------------------------------------------------------------------------

export interface Mission {
  topic: string
  why: string
  successLooksLike: string[]
  constraints: string[]
  outOfScope: string[]
}

export type MaterialsMode = 'own' | 'trusted' | 'mixed'

export interface Intake {
  timeline: string
  timePerWeek: string
  sessionLength: string
  priorExperience: string
  preferences: string
  materialsMode: MaterialsMode
}

export type ClassStage = 'intake' | 'active'

export interface ClassMeta {
  id: ID
  title: string
  createdAt: string
  updatedAt: string
  stage: ClassStage
  mission: Mission
  intake: Intake
  /** Allowlist for this class (starts as a copy of Settings.trustedDomains). */
  trustedDomains: string[]
  /** Accent hue (0-360) used for the class avatar. */
  hue: number
  /**
   * The lesson open in this class: it shows over every chat (or in the Study
   * tab), and every tutor in the class sees its study box. Belongs to the
   * class, not to the chat the lesson started in.
   */
  openLessonId?: ID
}

export interface ClassSummary {
  id: ID
  title: string
  stage: ClassStage
  topic: string
  createdAt: string
  updatedAt: string
  hue: number
  topicsTotal: number
  topicsMastered: number
  reviewsDue: number
  nextTopic: { id: ID; title: string } | null
  independence: IndependenceState
}

// ---------------------------------------------------------------------------
// Sources (the learner's materials, or approved trusted sources)
// ---------------------------------------------------------------------------

export type SourceKind = 'pdf' | 'web' | 'youtube' | 'markdown' | 'text' | 'docx' | 'html'
export type SourceOrigin = 'user' | 'trusted'
export type BlockType = 'heading' | 'paragraph' | 'list-item' | 'quote' | 'code' | 'cue'

export interface SourceBlock {
  /** Stable within a source: `s{sectionIndex}b{blockIndex}`. */
  id: string
  type: BlockType
  text: string
  /** Heading level 1-6 for headings. */
  level?: number
  /** Start time in seconds for transcript cues. */
  t?: number
}

export interface SourceSection {
  /** Stable within a source: `s{sectionIndex}`. */
  id: string
  /** Human locator used in citations: "p. 12", "03:15", or a heading. */
  label: string
  title?: string
  /** Start time in seconds for video sections. */
  t?: number
  blocks: SourceBlock[]
}

export interface SourceMeta {
  id: ID
  classId: ID
  kind: SourceKind
  title: string
  origin: SourceOrigin
  url?: string
  domain?: string
  author?: string
  videoId?: string
  /** Why mint proposed it (trusted sources only). */
  why?: string
  addedAt: string
  wordCount: number
  sectionCount: number
  /** Relative path of the stored original inside the class folder, if any. */
  originalFile?: string
  /** True when a video has no transcript yet (the learner can paste one). */
  needsTranscript?: boolean
}

export interface SourceDoc extends SourceMeta {
  sections: SourceSection[]
}

export interface SourceRef {
  sourceId: ID
  /** Section label, e.g. "p. 12" or "Eigenvalues". */
  section: string
  note?: string
}

export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'imported' | 'failed'

export interface SourceProposal {
  id: ID
  title: string
  url: string
  domain: string
  kind: 'web' | 'youtube'
  why: string
  covers: string
  /** The domain is not on the class allowlist yet; approving it trusts the domain. */
  newDomain: boolean
  status: ProposalStatus
  error?: string
  sourceId?: ID
}

// ---------------------------------------------------------------------------
// Curriculum (model proposes, code validates, learner approves)
// ---------------------------------------------------------------------------

export interface Topic {
  id: ID
  title: string
  objective: string
  prerequisites: ID[]
  sources: SourceRef[]
  practice: string
  gate: string
}

export interface Milestone {
  id: ID
  title: string
  deliverable: string
  topics: Topic[]
}

export interface Curriculum {
  version: number
  updatedAt: string
  summary: string
  project: { title: string; deliverable: string } | null
  assumptions: string[]
  cadence: string
  milestones: Milestone[]
}

export interface CurriculumProposal {
  id: ID
  createdAt: string
  reason: string
  curriculum: Curriculum
  status: 'pending' | 'accepted' | 'rejected'
  /** Problems code found and repaired while validating the model's plan. */
  repairs: string[]
}

export type CheckKind = 'explain' | 'apply' | 'distinguish'
export const CHECK_KINDS: CheckKind[] = ['explain', 'apply', 'distinguish']

export type TopicStatus = 'locked' | 'available' | 'in-progress' | 'mastered'

export interface CheckState {
  passed: boolean
  at?: string
  sessionId?: ID
}

export interface TopicProgress {
  topicId: ID
  status: TopicStatus
  checks: Record<CheckKind, CheckState>
  /** Index into the review ladder (days): 1, 3, 7, 14, 30, 60. */
  reviewStage: number
  nextReviewAt?: string
  lastStudiedAt?: string
}

// ---------------------------------------------------------------------------
// Diagnostic (intake)
// ---------------------------------------------------------------------------

export interface Diagnostic {
  questions: string[]
  answers: string[]
  result?: {
    summary: string
    startingLevel: string
    records: RecordProposal[]
  }
}

// ---------------------------------------------------------------------------
// Study sessions
// ---------------------------------------------------------------------------

export type Phase = 'brief' | 'read' | 'explain' | 'apply' | 'distinguish' | 'wrap'
export const PHASES: Phase[] = ['brief', 'read', 'explain', 'apply', 'distinguish', 'wrap']

export interface Brief {
  win: string
  whyItMatters: string
  readings: SourceRef[]
  questions: string[]
}

export type VerdictResult = 'pass' | 'partial' | 'fail'

export interface Verdict {
  result: VerdictResult
  /** Markdown; may contain [[cite:...]] directives. */
  feedback: string
  misconceptions: string[]
}

export interface CheckAttempt {
  id: ID
  kind: CheckKind
  prompt: string
  answer: string
  at: string
  verdict?: Verdict
}

export interface SessionWrap {
  records: RecordProposal[]
  terms: GlossaryProposal[]
  summary: string
}

export interface Session {
  id: ID
  classId: ID
  topicId: ID
  type: 'learn' | 'review'
  phase: Phase
  startedAt: string
  endedAt?: string
  brief?: Brief
  prompts: Partial<Record<CheckKind, string>>
  attempts: CheckAttempt[]
  wrap?: SessionWrap
}

// ---------------------------------------------------------------------------
// Ask threads, stickies, annotations
// ---------------------------------------------------------------------------

export interface TextRange {
  blockId: string
  start: number
  end: number
}

export type Anchor =
  | { kind: 'source'; sourceId: ID; sectionLabel: string; ranges: TextRange[]; quote: string }
  | { kind: 'message'; threadId: ID; messageId: ID; quote: string }
  | { kind: 'diagram'; explorableId: ID; elementId: string; label: string }
  | { kind: 'general'; context?: string }

/** Help ladder: 1 pointer, 2 guiding question, 3 hint, 4 explanation. */
export type Rung = 1 | 2 | 3 | 4
export const RUNG_LABELS: Record<Rung, string> = {
  1: 'Pointer',
  2: 'Guiding question',
  3: 'Hint',
  4: 'Explanation'
}

export interface ThreadMessage {
  id: ID
  role: 'user' | 'tutor'
  text: string
  at: string
  rung?: Rung
  error?: boolean
  /** Interactive content shown under the text (questions, a quiz, a code exercise, a lesson…). */
  widget?: Widget
}

// ---------------------------------------------------------------------------
// Chat widgets: the tutor's "tool calls" rendered inline in the conversation
// ---------------------------------------------------------------------------

export interface QuestionOption {
  label: string
  description?: string
}

/** One multiple-choice question, asked the way a coding agent asks (options plus "Other"). */
export interface ChoiceQuestion {
  id: string
  /** Very short chip label, e.g. "Goal". */
  header: string
  question: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface QuizQuestion {
  prompt: string
  options: string[]
  /** Index of the correct option. */
  answer: number
  explanation: string
}

export type CodeLanguage = 'javascript' | 'python'

export interface CodeExercise {
  title: string
  /** Markdown task description. */
  prompt: string
  language: CodeLanguage
  starter: string
  /**
   * Tests run after the learner's code in the same scope.
   * JavaScript: `test('name', () => { assertEqual(actual, expected) })`.
   * Python: functions named `test_*` using `assert`.
   */
  tests: string
  hint?: string
}

export interface CodeRunResult {
  ok: boolean
  output: string[]
  tests: { name: string; pass: boolean; message?: string }[]
  error?: string
}

export type Widget =
  | { kind: 'questions'; questions: ChoiceQuestion[]; answers?: Record<string, string[]>; skipped?: boolean }
  | { kind: 'plan'; version: number }
  | { kind: 'lesson'; sessionId: ID }
  | { kind: 'quiz'; title: string; questions: QuizQuestion[]; choices?: number[] }
  | { kind: 'code'; exercise: CodeExercise; submission?: { code: string; passed: number; total: number } }
  | { kind: 'diagram'; explorableId: ID }
  | { kind: 'sources' }

/** The learner's response to a widget. */
export type WidgetAnswer =
  | { kind: 'questions'; answers: Record<string, string[]>; note?: string }
  | { kind: 'questions'; skip: true }
  | { kind: 'quiz'; choices: number[] }
  | { kind: 'code'; code: string; result: CodeRunResult; streamId: string }

/** Tools the learner (or a tutor offer chip) can invoke in a chat. */
export type ChatCommand = 'quiz' | 'code' | 'diagram' | 'lesson' | 'plan'

export interface Thread {
  id: ID
  classId: ID
  anchor: Anchor
  title: string
  messages: ThreadMessage[]
  rung: Rung
  pinned: boolean
  sessionId?: ID
  createdAt: string
  updatedAt: string
}

export interface Annotation {
  id: ID
  classId: ID
  anchor: Extract<Anchor, { kind: 'source' }>
  kind: 'highlight' | 'note'
  text?: string
  createdAt: string
  updatedAt: string
}

export interface HelpEvent {
  id: ID
  at: string
  threadId: ID
  rung: Rung
  defaultRung: Rung
  escalated: boolean
}

export type IndependenceLevel = 0 | 1 | 2 | 3

export interface IndependenceState {
  level: IndependenceLevel
  score: number
  defaultRung: Rung
  reason: string
  history: { at: string; score: number }[]
  asks: number
}

// ---------------------------------------------------------------------------
// Learning records (ADR-style, from /teach), glossary, notes
// ---------------------------------------------------------------------------

export type RecordKind = 'understanding' | 'prior-knowledge' | 'misconception' | 'mission-shift'

export interface RecordProposal {
  title: string
  body: string
  evidence: string
  kind: RecordKind
  topicId?: ID
}

export interface LearningRecord {
  id: ID
  number: number
  slug: string
  title: string
  body: string
  evidence: string
  kind: RecordKind
  topicId?: ID
  sessionId?: ID
  supersededBy?: ID
  createdAt: string
}

export interface GlossaryProposal {
  term: string
  definition: string
  avoid: string[]
  evidence: string
}

export interface GlossaryTerm {
  id: ID
  term: string
  definition: string
  avoid: string[]
  sourceRef?: SourceRef
  addedAt: string
  updatedAt: string
}

export type NoteFormat = 'markdown' | 'html'

export interface NoteDoc {
  id: ID
  classId: ID
  kind: 'note' | 'reference'
  title: string
  body: string
  /** "html" for notes written in the rich notepad; markdown otherwise (tutor drafts, saved side chats). */
  format?: NoteFormat
  authoredBy: 'learner' | 'tutor-draft'
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Explorables (interactive diagrams)
// ---------------------------------------------------------------------------

export type DiagramEngine = 'p5' | 'three'

export interface DiagramElement {
  id: string
  label: string
  description: string
}

export interface DiagramParam {
  id: string
  label: string
  min: number
  max: number
  step: number
  value: number
}

export interface DiagramSpec {
  engine: DiagramEngine
  title: string
  code: string
  elements: DiagramElement[]
  params: DiagramParam[]
  caption: string
}

export interface Explorable {
  id: ID
  classId: ID
  spec: DiagramSpec
  prompt: string
  anchor?: Anchor
  kept: boolean
  repairs: number
  createdAt: string
}

// ---------------------------------------------------------------------------
// Aggregates sent to the renderer
// ---------------------------------------------------------------------------

export interface ClassBundle {
  meta: ClassMeta
  sources: SourceMeta[]
  sourceProposals: SourceProposal[]
  diagnostic: Diagnostic | null
  curriculum: Curriculum | null
  curriculumProposals: CurriculumProposal[]
  progress: Record<ID, TopicProgress>
  sessions: Session[]
  threads: Thread[]
  annotations: Annotation[]
  records: LearningRecord[]
  glossary: GlossaryTerm[]
  notes: NoteDoc[]
  explorables: Explorable[]
  independence: IndependenceState
  helpEvents: HelpEvent[]
  nextTopicId: ID | null
  reviewsDue: ID[]
}

// ---------------------------------------------------------------------------
// Events pushed from main to renderer
// ---------------------------------------------------------------------------

export interface StreamEvent {
  streamId: string
  /** Sent once at the start of an Ask turn so the UI knows the thread before the reply finishes. */
  threadId?: string
  delta?: string
  done?: boolean
  error?: string
}

export interface ProgressEvent {
  classId: ID
  jobId: string
  label: string
  state: 'running' | 'done' | 'error'
  detail?: string
  /** A background failure nobody awaits: the UI shows it as a toast. */
  notice?: boolean
}
