import type { Anchor, HelpEvent, Rung, Thread, ThreadMessage } from '@shared/types'
import { findTopic } from '@shared/curriculum'
import { tutorReply, type ThreadContext } from '../jobs'
import { AgentError } from '../agents/types'
import { newId, nowIso } from '../store/fsutil'
import type { Kernel } from './kernel'
import { userError, userMessage } from './kernel'

interface AskInput {
  classId: string
  streamId: string
  voice?: boolean
}

export class ThreadService {
  private inflight = new Map<string, AbortController>()

  constructor(private readonly k: Kernel) {}

  cancel(streamId: string): void {
    this.inflight.get(streamId)?.abort()
  }

  async create(input: AskInput & { anchor: Anchor; message: string; via: 'text' | 'voice'; sessionId?: string }): Promise<Thread> {
    const { classId } = input
    const message = input.message.trim().slice(0, 4000)
    if (!message) throw userError('Type (or say) your question first.')
    const anchor = await this.validateAnchor(classId, input.anchor)

    // Nesting cap: a follow-up on a reply that is itself a follow-up stays in that thread.
    if (anchor.kind === 'message') {
      const threads = await this.k.repo.read(classId, 'threads')
      const parent = threads.find((t) => t.id === anchor.threadId)
      if (parent && parent.anchor.kind === 'message') {
        return this.send({ classId, threadId: parent.id, message: `> ${anchor.quote}\n\n${message}`, via: input.via, streamId: input.streamId, voice: input.voice })
      }
    }

    const independence = await this.k.independence(classId)
    const now = nowIso()
    const thread: Thread = {
      id: newId('thr'),
      classId,
      anchor,
      title: titleFor(anchor, message),
      messages: [{ id: newId('msg'), role: 'user', text: message, at: now, via: input.via }],
      rung: independence.defaultRung,
      pinned: false,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now
    }
    await this.k.repo.lock(classId, async () => {
      await this.k.repo.update(classId, 'threads', (list) => [...list, thread])
      await this.logHelp(classId, thread.id, thread.rung, independence.defaultRung, false)
    })
    this.k.changed(classId)
    return this.reply(classId, thread.id, thread.rung, input)
  }

  async send(input: AskInput & { threadId: string; message: string; via: 'text' | 'voice' }): Promise<Thread> {
    const { classId, threadId } = input
    const message = input.message.trim().slice(0, 4000)
    if (!message) throw userError('Type (or say) your question first.')
    const independence = await this.k.independence(classId)
    // Every new question starts again at the default rung; escalation is per question.
    const rung = independence.defaultRung
    await this.k.repo.lock(classId, async () => {
      await this.mutate(classId, threadId, (t) => ({
        ...t,
        rung,
        messages: [...t.messages, { id: newId('msg'), role: 'user', text: message, at: nowIso(), via: input.via }],
        updatedAt: nowIso()
      }))
      await this.logHelp(classId, threadId, rung, independence.defaultRung, false)
    })
    this.k.changed(classId)
    return this.reply(classId, threadId, rung, input)
  }

  /** The learner deliberately climbs one rung of the help ladder. */
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
    const controller = new AbortController()
    this.inflight.set(input.streamId, controller)
    let text: string
    let failed = false
    try {
      const threads = await this.k.repo.read(classId, 'threads')
      const thread = threads.find((t) => t.id === threadId)
      if (!thread) throw userError('That thread no longer exists.')
      const ctx = await this.k.context(classId)
      const tctx = await this.threadContext(classId, thread, rung, Boolean(input.voice))
      text = await tutorReply({ runtime: await this.k.runtime(), ctx, signal: controller.signal }, tctx, (delta) =>
        this.k.emitter.stream({ streamId: input.streamId, delta })
      )
      this.k.emitter.stream({ streamId: input.streamId, done: true })
    } catch (err) {
      failed = true
      const aborted = err instanceof AgentError && err.kind === 'aborted'
      text = aborted ? '_Stopped._' : `Sorry, I could not answer: ${userMessage(err)}`
      this.k.emitter.stream({ streamId: input.streamId, error: aborted ? 'Stopped' : userMessage(err), done: true })
    } finally {
      this.inflight.delete(input.streamId)
    }
    const msg: ThreadMessage = { id: newId('msg'), role: 'tutor', text, at: nowIso(), rung, error: failed || undefined }
    const updated = await this.k.repo.lock(classId, () =>
      this.mutate(classId, threadId, (t) => ({ ...t, messages: [...t.messages, msg], updatedAt: nowIso() }))
    )
    this.k.changed(classId)
    return updated
  }

  private async threadContext(classId: string, thread: Thread, rung: Rung, voice: boolean): Promise<ThreadContext> {
    const a = thread.anchor
    let anchorContext = ''
    let explorable
    if (a.kind === 'source') {
      try {
        const doc = await this.k.repo.readSource(classId, a.sourceId)
        const section = doc.sections.find((s) => s.label === a.sectionLabel) ?? doc.sections.find((s) => s.blocks.some((b) => b.id === a.ranges[0]?.blockId))
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
    let sessionTopic
    if (thread.sessionId) {
      const session = (await this.k.repo.read(classId, 'sessions')).find((s) => s.id === thread.sessionId)
      if (session) sessionTopic = findTopic(await this.k.repo.read(classId, 'curriculum'), session.topicId)
    }
    return { thread, rung, voice, anchorContext, explorable, sessionTopic }
  }

  private async validateAnchor(classId: string, anchor: Anchor): Promise<Anchor> {
    switch (anchor?.kind) {
      case 'source': {
        const doc = await this.k.repo.readSource(classId, anchor.sourceId)
        const blockIds = new Set(doc.sections.flatMap((s) => s.blocks.map((b) => b.id)))
        const ranges = (anchor.ranges ?? []).filter((r) => blockIds.has(r.blockId) && r.end > r.start).slice(0, 50)
        if (!ranges.length) throw userError('That selection could not be located in the source.')
        return { kind: 'source', sourceId: doc.id, sectionLabel: String(anchor.sectionLabel ?? ''), ranges, quote: String(anchor.quote ?? '').slice(0, 2000) }
      }
      case 'message':
        return { kind: 'message', threadId: String(anchor.threadId), messageId: String(anchor.messageId), quote: String(anchor.quote ?? '').slice(0, 2000) }
      case 'diagram':
        return { kind: 'diagram', explorableId: String(anchor.explorableId), elementId: String(anchor.elementId), label: String(anchor.label ?? anchor.elementId) }
      case 'general':
        return { kind: 'general', context: anchor.context ? String(anchor.context).slice(0, 2000) : undefined }
      default:
        throw userError('Unknown anchor.')
    }
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

function titleFor(anchor: Anchor, message: string): string {
  const base = anchor.kind === 'source' || anchor.kind === 'message' ? anchor.quote : anchor.kind === 'diagram' ? anchor.label : message
  const t = (base || message).replace(/\s+/g, ' ').trim()
  return t.length > 70 ? `${t.slice(0, 67)}…` : t
}
