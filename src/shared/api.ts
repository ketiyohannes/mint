import type { ModelOption,
  Anchor,
  ChatCommand,
  WidgetAnswer,
  CheckKind,
  ClassBundle,
  ClassMeta,
  ClassSummary,
  Explorable,
  GlossaryTerm,
  Intake,
  Mission,
  NoteDoc,
  ProgressEvent,
  ProviderId,
  SecretName,
  Session,
  SettingsView,
  Settings,
  SourceDoc,
  SourceMeta,
  StreamEvent,
  Thread
} from './types'

/**
 * The renderer's entire view of the main process. Every method is an IPC
 * invoke; the main process owns all state and validation.
 */
export interface MintApi {
  settings: {
    get(): Promise<SettingsView>
    update(patch: Partial<Settings>): Promise<SettingsView>
    setSecret(name: SecretName, value: string | null): Promise<SettingsView>
    testProvider(provider: ProviderId): Promise<{ ok: boolean; message: string }>
    /** The models a harness offers. Cached per session; `refresh` asks the harness again. */
    models(provider: ProviderId, refresh?: boolean): Promise<{ models: ModelOption[]; error?: string }>
    openDataDir(): Promise<void>
  }
  classes: {
    list(): Promise<ClassSummary[]>
    get(classId: string): Promise<ClassBundle>
    create(input: { title: string; mission: Mission; intake: Intake }): Promise<ClassMeta>
    /**
     * Project-style creation: a name and materials (files, folders, links).
     * Returns at once; importing and planning continue in the background.
     * With no materials, mint proposes trusted sources for the topic instead.
     */
    start(input: { title?: string; goal?: string; paths?: string[]; urls?: string[] }): Promise<ClassMeta>
    update(classId: string, patch: { title?: string; mission?: Mission; intake?: Intake; trustedDomains?: string[] }): Promise<ClassMeta>
    remove(classId: string): Promise<void>
    activate(classId: string): Promise<void>
  }
  sources: {
    /** Opens a file dialog when `paths` is omitted. Folders are imported like a project. Returns the imported sources and per-file errors. */
    addFiles(classId: string, paths?: string[]): Promise<{ added: SourceMeta[]; errors: string[] }>
    /** The original PDF bytes for the page view (null for other kinds). */
    original(classId: string, sourceId: string): Promise<Uint8Array | null>
    addUrl(classId: string, url: string): Promise<SourceMeta>
    get(classId: string, sourceId: string): Promise<SourceDoc>
    remove(classId: string, sourceId: string): Promise<void>
    setTranscript(classId: string, sourceId: string, text: string): Promise<SourceMeta>
    proposeTrusted(classId: string, focus?: string): Promise<void>
    resolveProposals(classId: string, approve: string[], reject: string[]): Promise<void>
  }
  intake: {
    startDiagnostic(classId: string): Promise<void>
    submitDiagnostic(classId: string, answers: string[]): Promise<void>
    skipDiagnostic(classId: string): Promise<void>
    proposeCurriculum(classId: string, reason?: string): Promise<void>
    resolveCurriculum(classId: string, proposalId: string, accept: boolean): Promise<void>
    /** Plan (or re-plan with a reason) and apply the result directly. */
    autoPlan(classId: string, reason?: string): Promise<void>
  }
  sessions: {
    start(classId: string, topicId: string, type: 'learn' | 'review'): Promise<Session>
    setPhase(classId: string, sessionId: string, phase: Session['phase']): Promise<Session>
    submitCheck(classId: string, sessionId: string, kind: CheckKind, answer: string): Promise<Session>
    finish(classId: string, sessionId: string, acceptRecords: number[], acceptTerms: number[]): Promise<Session>
    abandon(classId: string, sessionId: string): Promise<void>
  }
  /** The class chat: intake, tutor replies, and tools that post interactive widgets. */
  chat: {
    /** Omit threadId to start a new chat. */
    send(input: { classId: string; threadId?: string; message: string; streamId: string }): Promise<Thread>
    answer(input: { classId: string; threadId: string; messageId: string; answer: WidgetAnswer }): Promise<Thread>
    command(input: { classId: string; threadId?: string; command: ChatCommand; arg?: string }): Promise<Thread>
  }
  threads: {
    create(input: { classId: string; anchor: Anchor; message: string; sessionId?: string; streamId: string }): Promise<Thread>
    send(input: { classId: string; threadId: string; message: string; streamId: string }): Promise<Thread>
    moreHelp(input: { classId: string; threadId: string; streamId: string }): Promise<Thread>
    setPinned(classId: string, threadId: string, pinned: boolean): Promise<Thread>
    remove(classId: string, threadId: string): Promise<void>
    cancel(streamId: string): Promise<void>
  }
  annotations: {
    create(classId: string, anchor: Extract<Anchor, { kind: 'source' }>, kind: 'highlight' | 'note', text?: string): Promise<void>
    update(classId: string, annotationId: string, text: string): Promise<void>
    remove(classId: string, annotationId: string): Promise<void>
  }
  notes: {
    save(classId: string, note: Pick<NoteDoc, 'kind' | 'title' | 'body' | 'format'> & { id?: string }): Promise<NoteDoc>
    remove(classId: string, noteId: string): Promise<void>
    draftReference(classId: string, topicId: string | null): Promise<NoteDoc>
    review(classId: string, noteId: string, streamId: string): Promise<string>
    /** Promote a thread (sticky) into a learner note. */
    fromThread(classId: string, threadId: string): Promise<NoteDoc>
  }
  glossary: {
    /** The learner defines a term in their own words; the tutor checks it against the sources. */
    propose(classId: string, term: string, definition: string, anchor?: Anchor): Promise<{ accepted: boolean; feedback: string; term?: GlossaryTerm }>
    update(classId: string, termId: string, patch: Partial<Pick<GlossaryTerm, 'term' | 'definition' | 'avoid'>>): Promise<void>
    remove(classId: string, termId: string): Promise<void>
  }
  records: {
    supersede(classId: string, recordId: string, title: string, body: string): Promise<void>
  }
  diagrams: {
    create(classId: string, prompt: string, anchor?: Anchor): Promise<Explorable>
    repair(classId: string, explorableId: string, error: string): Promise<Explorable>
    setKept(classId: string, explorableId: string, kept: boolean): Promise<void>
    remove(classId: string, explorableId: string): Promise<void>
  }
  system: {
    /** Native picker for files and folders. Returns absolute paths (empty when cancelled). */
    pickMaterials(): Promise<string[]>
    openExternal(url: string): Promise<void>
    platform(): Promise<string>
  }
  on: {
    stream(cb: (e: StreamEvent) => void): () => void
    progress(cb: (e: ProgressEvent) => void): () => void
    classChanged(cb: (classId: string) => void): () => void
  }
}

/** Flattened channel names: "<group>:<method>". */
export const API_GROUPS = {
  settings: ['get', 'update', 'setSecret', 'testProvider', 'models', 'openDataDir'],
  classes: ['list', 'get', 'create', 'start', 'update', 'remove', 'activate'],
  sources: ['addFiles', 'original', 'addUrl', 'get', 'remove', 'setTranscript', 'proposeTrusted', 'resolveProposals'],
  intake: ['startDiagnostic', 'submitDiagnostic', 'skipDiagnostic', 'proposeCurriculum', 'resolveCurriculum', 'autoPlan'],
  sessions: ['start', 'setPhase', 'submitCheck', 'finish', 'abandon'],
  chat: ['send', 'answer', 'command'],
  threads: ['create', 'send', 'moreHelp', 'setPinned', 'remove', 'cancel'],
  annotations: ['create', 'update', 'remove'],
  notes: ['save', 'remove', 'draftReference', 'review', 'fromThread'],
  glossary: ['propose', 'update', 'remove'],
  records: ['supersede'],
  diagrams: ['create', 'repair', 'setKept', 'remove'],
  system: ['pickMaterials', 'openExternal', 'platform']
} as const satisfies { [K in Exclude<keyof MintApi, 'on'>]: readonly (keyof MintApi[K])[] }

export const EVENT_CHANNELS = {
  stream: 'event:stream',
  progress: 'event:progress',
  classChanged: 'event:classChanged'
} as const

/** Errors cross IPC as plain messages; this prefix marks user-facing ones. */
export const USER_ERROR_PREFIX = 'mint:'
