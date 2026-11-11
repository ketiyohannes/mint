import { sessionPhases } from '@shared/depth'
import { CHECK_KINDS, type Anchor, type HelpEvent, type Rung, type Thread, type ThreadMessage, type Widget } from '@shared/types'
import { titleText } from '@shared/quote'
import { findTopic } from '@shared/curriculum'
import { tutorReply, type StudyDraft, type ThreadContext } from '../jobs'
import { AgentError } from '../agents/types'
import { newId, nowIso } from '../store/fsutil'
import { cleanAnchor, validateSourceAnchor } from './anchors'
import type { Kernel } from './kernel'
import { userError, userMessage } from './kernel'

interface AskInput {
  classId: string
  streamId: string
  /** An unsent answer in the lesson's study box, for the tutor to see. */
  studyDraft?: StudyDraft
}

export class ThreadService {
  private inflight = new Map<string, AbortController>()

  constructor(private readonly k: Kernel) {}

  cancel(streamId: string): void {
    this.inflight.get(streamId)?.abort()
  }

  /**
   * Run chat work that the learner can stop (the composer's stop button sends
   * `cancel(streamId)`). Stopping settles at once with an 'aborted' AgentError;
   * the work gets the signal so model turns end too.
   */
  async track<T>(streamId: string | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    if (streamId) this.inflight.set(streamId, controller)
    let onAbort = () => {}
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AgentError('Cancelled', 'aborted'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const running = work(controller.signal)
    // Work still finishing after a stop must not surface as an unhandled rejection.
    running.catch(() => undefined)
    try {
      return await Promise.race([running, stopped])
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
      if (streamId && this.inflight.get(streamId) === controller) this.inflight.delete(streamId)
    }
  }

  async create(input: AskInput & { anchor: Anchor; message: string; sessionId?: string }): Promise<Thread> {
    const { classId } = input
    const message = String(input.message ?? '')
      .trim()
      .slice(0, 4000)
    if (!message) throw userError('Type your question first.')
    const anchor = await this.validateAnchor(classId, input.anchor)

    // Nesting cap: a follow-up on a reply that is itself a follow-up stays in that thread.
    if (anchor.kind === 'message') {
      const threads = await this.k.repo.read(classId, 'threads')
      const parent = threads.find((t) => t.id === anchor.threadId)
      if (parent && parent.anchor.kind === 'message') {
        return this.send({ classId, threadId: parent.id, message: `> ${anchor.quote}\n\n${message}`, streamId: input.streamId, studyDraft: input.studyDraft })
      }
    }

    const start = await this.startRung(classId)
    const now = nowIso()
    const thread: Thread = {
      id: newId('thr'),
      classId,
      anchor,
      title: titleFor(anchor, message),
      messages: [{ id: newId('msg'), role: 'user', text: message, at: now }],
      rung: start.rung,
      pinned: false,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now
    }
    await this.k.repo.lock(classId, async () => {
      await this.k.repo.update(classId, 'threads', (list) => [...list, thread])
      if (start.ladder) await this.logHelp(classId, thread.id, thread.rung, start.defaultRung, false)
    })
    this.k.changed(classId)
    return this.reply(classId, thread.id, thread.rung, input)
  }

  async send(input: AskInput & { threadId: string; message: string }): Promise<Thread> {
    const { classId, threadId } = input
    const message = String(input.message ?? '')
      .trim()
      .slice(0, 4000)
    if (!message) throw userError('Type your question first.')
    // Every new question starts again at the starting rung; escalation is per question.
    const start = await this.startRung(classId)
    const rung = start.rung
    await this.k.repo.lock(classId, async () => {
      await this.mutate(classId, threadId, (t) => ({
        ...t,
        rung,
        messages: [...t.messages, { id: newId('msg'), role: 'user', text: message, at: nowIso() }],
        updatedAt: nowIso()
      }))
      if (start.ladder) await this.logHelp(classId, threadId, rung, start.defaultRung, false)
    })
    this.k.changed(classId)
    return this.reply(classId, threadId, rung, input)
  }

  /**
   * Where a new question starts. Teach (the default): a full, in-depth
   * explanation. Coach: the learner's rung on the help ladder, which climbs on
   * request and is logged as evidence of independence.
   */
  private async startRung(classId: string): Promise<{ rung: Rung; defaultRung: Rung; ladder: boolean }> {
    const [settings, independence] = await Promise.all([this.k.settings.get(), this.k.independence(classId)])
    const ladder = settings.tutorStyle === 'coach'
    return { rung: ladder ? independence.defaultRung : 4, defaultRung: independence.defaultRung, ladder }
  }

  /** The learner deliberately climbs one rung of the help ladder (Coach style). */
  async moreHelp(input: AskInput & { threadId: string }): Promise<Thread> {
    const { classId, threadId } = input
    const independence = await this.k.independence(classId)
    let rung: Rung = 4
    await this.k.repo.lock(classId, async () => {
      const t = await this.mutate(classId, threadId, (t) => {
        if (!t.messages.some((m) => m.role === 'user')) throw userError('Ask a question first.')
        if (t.rung >= 4) throw userError('This is already the full explanation.')
        return { ...t, rung: (t.rung + 1) as Rung, updatedAt: nowIso() }
      })
      rung = t.rung
      await this.logHelp(classId, threadId, rung, independence.defaultRung, true)
    })
    this.k.changed(classId)
    return this.reply(classId, threadId, rung, input)
  }

  async setPinned(classId: string, threadId: string, pinned: boolean): Promise<Thread> {
    const t = await this.k.repo.lock(classId, () => this.mutate(classId, threadId, (t) => ({ ...t, pinned, updatedAt: nowIso() })))
    this.k.changed(classId)
    return t
  }

  async remove(classId: string, threadId: string): Promise<void> {
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'threads', (list) => list.filter((t) => t.id !== threadId)))
    this.k.changed(classId)
  }

  private async reply(classId: string, threadId: string, rung: Rung, input: AskInput): Promise<Thread> {
    return this.streamReply(classId, threadId, input.streamId, rung, async (signal, onDelta) => {
      const threads = await this.k.repo.read(classId, 'threads')
      const thread = threads.find((t) => t.id === threadId)
      if (!thread) throw userError('That thread no longer exists.')
      const ctx = await this.k.context(classId)
      const tctx = await this.threadContext(classId, thread, rung, cleanDraft(input.studyDraft))
      return tutorReply({ runtime: await this.k.runtime(), ctx, signal }, tctx, onDelta)
    })
  }

  /**
   * Stream a tutor message produced by `produce` into a thread (cancellable via
   * `cancel(streamId)`); failures become an error message instead of throwing.
   */
  async streamReply(classId: string, threadId: string, streamId: string, rung: Rung | undefined, produce: (signal: AbortSignal, onDelta: (d: string) => void) => Promise<string>): Promise<Thread> {
    this.k.emitter.stream({ streamId, threadId })
    let streamed = ''
    let text: string
    let failed = false
    try {
      text = await this.track(streamId, (signal) =>
        produce(signal, (delta) => {
          if (signal.aborted) return
          streamed += delta
          this.k.emitter.stream({ streamId, delta })
        })
      )
      this.k.emitter.stream({ streamId, done: true })
    } catch (err) {
      const aborted = err instanceof AgentError && err.kind === 'aborted'
      // A stopped reply keeps what the learner already read.
      text = aborted ? (streamed.trim() ? `${streamed.trimEnd()}\n\n_Stopped._` : '_Stopped._') : `Sorry, I could not answer: ${userMessage(err)}`
      failed = !aborted
      this.k.emitter.stream({ streamId, error: aborted ? 'Stopped' : userMessage(err), done: true })
    }
    return this.append(classId, threadId, [{ role: 'tutor', text, rung, error: failed || undefined }])
  }

  /** A new top-level chat (general anchor) that starts with the given messages. */
  async createChat(classId: string, title: string, messages: NewMessage[] = [], sessionId?: string): Promise<Thread> {
    const { rung } = await this.startRung(classId)
    const now = nowIso()
    const t = titleText(title)
    const thread: Thread = {
      id: newId('thr'),
      classId,
      anchor: { kind: 'general' },
      title: (t.length > 70 ? `${t.slice(0, 67)}…` : t) || 'New chat',
      messages: messages.map(toMessage),
      rung,
      pinned: false,
      sessionId,
      createdAt: now,
      updatedAt: now
    }
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'threads', (list) => [...list, thread]))
    this.k.changed(classId)
    return thread
  }

  /** Append messages to a thread (no tutor reply). */
  async append(classId: string, threadId: string, messages: NewMessage[], patch: Partial<Pick<Thread, 'sessionId'>> = {}): Promise<Thread> {
    const updated = await this.k.repo.lock(classId, () => this.mutate(classId, threadId, (t) => ({ ...t, ...patch, messages: [...t.messages, ...messages.map(toMessage)], updatedAt: nowIso() })))
    this.k.changed(classId)
    return updated
  }

  /** Update one message's widget (the learner answered a quiz, submitted code, …). */
  async patchWidget(classId: string, threadId: string, messageId: string, fn: (w: Widget) => Widget): Promise<Thread> {
    const updated = await this.k.repo.lock(classId, () =>
      this.mutate(classId, threadId, (t) => {
        const m = t.messages.find((x) => x.id === messageId)
        if (!m?.widget) throw userError('That item is no longer in the chat.')
        return { ...t, messages: t.messages.map((x) => (x.id === messageId ? { ...x, widget: fn(x.widget!) } : x)), updatedAt: nowIso() }
      })
    )
    this.k.changed(classId)
    return updated
  }

  private async threadContext(classId: string, thread: Thread, rung: Rung, studyDraft?: StudyDraft): Promise<ThreadContext> {
    const a = thread.anchor
    let anchorContext = ''
    let explorable
    if (a.kind === 'source') {
      try {
        const doc = await this.k.repo.readSource(classId, a.sourceId)
        // Block ids are unique in a source; labels are not always (older imports may repeat a heading).
        const section = doc.sections.find((s) => s.blocks.some((b) => b.id === a.ranges[0]?.blockId)) ?? doc.sections.find((s) => s.label === a.sectionLabel)
        if (section) {
          const first = section.blocks.findIndex((b) => b.id === a.ranges[0]?.blockId)
          const lastId = a.ranges[a.ranges.length - 1]?.blockId
          const last = section.blocks.findIndex((b) => b.id === lastId)
          const from = Math.max(0, (first < 0 ? 0 : first) - 3)
          const to = Math.min(section.blocks.length, (last < 0 ? first : last) + 4)
          anchorContext = section.blocks
            .slice(from, to)
            .map((b) => `${b.text}  ^${b.id}`)
            .join('\n')
            .slice(0, 5000)
        }
      } catch {
        anchorContext = ''
      }
    } else if (a.kind === 'message') {
      const threads = await this.k.repo.read(classId, 'threads')
      anchorContext = threads.find((t) => t.id === a.threadId)?.messages.find((m) => m.id === a.messageId)?.text ?? ''
    } else if (a.kind === 'diagram') {
      explorable = (await this.k.repo.read(classId, 'explorables')).find((e) => e.id === a.explorableId)
    }
    // Every chat in the class sees the open lesson, wherever that lesson started.
    let sessionTopic
    let session
    const { openLessonId } = await this.k.repo.requireMeta(classId)
    if (openLessonId) {
      session = (await this.k.repo.read(classId, 'sessions')).find((s) => s.id === openLessonId)
      if (session) sessionTopic = findTopic(await this.k.repo.read(classId, 'curriculum'), session.topicId)
    }
    const sessionSteps = session && sessionPhases(session, (await this.k.settings.get()).studyDepth)
    return { thread, rung, anchorContext, explorable, sessionTopic, session, sessionSteps, studyDraft: session && !session.endedAt ? studyDraft : undefined }
  }

  private async validateAnchor(classId: string, anchor: Anchor): Promise<Anchor> {
    if (anchor?.kind === 'source') return validateSourceAnchor(this.k, classId, anchor)
    const clean = cleanAnchor(anchor)
    if (!clean) throw userError('Unknown anchor.')
    return clean
  }

  private async mutate(classId: string, threadId: string, fn: (t: Thread) => Thread): Promise<Thread> {
    let out: Thread | undefined
    await this.k.repo.update(classId, 'threads', (list) =>
      list.map((t) => {
        if (t.id !== threadId) return t
        out = fn(t)
        return out
      })
    )
    if (!out) throw userError('That thread no longer exists.')
    return out
  }

  private async logHelp(classId: string, threadId: string, rung: Rung, defaultRung: Rung, escalated: boolean): Promise<void> {
    const event: HelpEvent = { id: newId('help'), at: nowIso(), threadId, rung, defaultRung, escalated }
    await this.k.repo.update(classId, 'helpEvents', (list) => [...list, event].slice(-2000))
    await this.k.snapshotIndependence(classId)
  }
}

export type NewMessage = Omit<ThreadMessage, 'id' | 'at'>

function toMessage(m: NewMessage): ThreadMessage {
  return { ...m, id: newId('msg'), at: nowIso() }
}

function titleFor(anchor: Anchor, message: string): string {
  const base = anchor.kind === 'source' || anchor.kind === 'message' ? anchor.quote : anchor.kind === 'diagram' ? anchor.label : titleText(message)
  const t = (base || titleText(message)).replace(/\s+/g, ' ').trim()
  return t.length > 70 ? `${t.slice(0, 67)}…` : t
}

/** Input from the renderer: only a real check kind and bounded text get through. */
function cleanDraft(d: StudyDraft | undefined): StudyDraft | undefined {
  if (!d || !CHECK_KINDS.includes(d.kind) || typeof d.text !== 'string' || !d.text.trim()) return undefined
  return { kind: d.kind, text: d.text.slice(0, 4000) }
}
