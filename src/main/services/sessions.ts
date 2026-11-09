import { CHECK_KINDS, PHASES, type CheckAttempt, type CheckKind, type GlossaryTerm, type Phase, type Session } from '@shared/types'
import { findTopic } from '@shared/curriculum'
import { checkPrompt, judgeCheck, wrapSession, writeBrief } from '../jobs'
import { applyCheck, applyReviewOutcome, emptyProgress } from '../learning/engine'
import { newId, nowIso } from '../store/fsutil'
import type { Kernel } from './kernel'
import { userError } from './kernel'
import { appendRecords } from './records'

const CHECK_PHASES: Partial<Record<Phase, CheckKind>> = { explain: 'explain', apply: 'apply', distinguish: 'distinguish' }

export class SessionService {
  constructor(private readonly k: Kernel) {}

  private async load(classId: string, sessionId: string): Promise<Session> {
    const sessions = await this.k.repo.read(classId, 'sessions')
    const s = sessions.find((x) => x.id === sessionId)
    if (!s) throw userError('That session no longer exists.')
    return s
  }

  private async save(classId: string, session: Session): Promise<void> {
    await this.k.repo.update(classId, 'sessions', (list) => {
      const i = list.findIndex((s) => s.id === session.id)
      if (i < 0) return [...list, session]
      const copy = [...list]
      copy[i] = session
      return copy
    })
  }

  /** Start (or resume) a study or review session for a topic. */
  async start(classId: string, topicId: string, type: Session['type'], signal?: AbortSignal): Promise<Session> {
    const ctx = await this.k.context(classId)
    const topic = findTopic(ctx.curriculum, topicId)
    if (!topic) throw userError('That topic is not in the curriculum.')
    const sessions = await this.k.repo.read(classId, 'sessions')
    const open = sessions.find((s) => s.topicId === topicId && !s.endedAt && s.type === type)
    if (open?.brief) {
      // Starting a lesson that is already under way picks it up where it was.
      await this.open(classId, open.id)
      return open
    }

    const brief = await this.k.job(classId, type === 'review' ? 'Preparing your review' : 'Writing your session brief', async () =>
      writeBrief({ runtime: await this.k.runtime(), ctx, signal }, topic, type)
    )
    // Code keeps only readings that point at real sources.
    const sourceIds = new Set(ctx.sources.map((s) => s.meta.id))
    const readings = brief.readings.filter((r) => sourceIds.has(r.sourceId)).map((r) => ({ sourceId: r.sourceId, section: r.section, note: r.note || undefined }))
    const session: Session = open ?? {
      id: newId('ses'),
      classId,
      topicId,
      type,
      phase: 'brief',
      startedAt: nowIso(),
      prompts: {},
      attempts: []
    }
    session.brief = {
      win: brief.win.trim(),
      whyItMatters: brief.whyItMatters.trim(),
      readings: readings.length ? readings : topic.sources,
      questions: brief.questions.map((q) => q.trim()).filter(Boolean).slice(0, 4)
    }
    await this.k.repo.lock(classId, async () => {
      await this.save(classId, session)
      await this.setOpen(classId, session.id)
      await this.k.repo.update(classId, 'progress', (p) => ({
        ...p,
        [topicId]: { ...(p[topicId] ?? emptyProgress(topicId)), lastStudiedAt: nowIso() }
      }))
      await this.k.refreshProgress(classId)
    })
    this.k.changed(classId)
    return session
  }

  async setPhase(classId: string, sessionId: string, phase: Phase): Promise<Session> {
    if (!PHASES.includes(phase)) throw userError('Unknown phase.')
    const session = await this.load(classId, sessionId)
    if (session.endedAt) throw userError('This session has ended.')
    const kind = CHECK_PHASES[phase]
    if (kind && !session.prompts[kind]) {
      const ctx = await this.k.context(classId)
      const topic = findTopic(ctx.curriculum, session.topicId)
      if (!topic) throw userError('That topic is not in the curriculum anymore.')
      const prompt = await this.k.job(classId, 'Preparing a check', async () => checkPrompt({ runtime: await this.k.runtime(), ctx }, topic, session.brief, kind))
      session.prompts = { ...session.prompts, [kind]: prompt }
    }
    if (phase === 'wrap' && !session.wrap) {
      const ctx = await this.k.context(classId)
      const topic = findTopic(ctx.curriculum, session.topicId)
      if (!topic) throw userError('That topic is not in the curriculum anymore.')
      const wrap = await this.k.job(classId, 'Wrapping up', async () => wrapSession({ runtime: await this.k.runtime(), ctx }, topic, session))
      const known = new Set(ctx.glossary.map((g) => g.term.toLowerCase()))
      session.wrap = {
        summary: wrap.summary.trim(),
        records: wrap.records.map((r) => ({ ...r, topicId: session.topicId })).slice(0, 4),
        terms: wrap.terms.filter((t) => t.term.trim() && !known.has(t.term.trim().toLowerCase())).slice(0, 5)
      }
    }
    session.phase = phase
    await this.k.repo.lock(classId, async () => {
      // Re-read under the lock and merge only what this call owns.
      const fresh = await this.load(classId, sessionId)
      await this.save(classId, { ...fresh, phase, prompts: { ...fresh.prompts, ...session.prompts }, wrap: fresh.wrap ?? session.wrap })
    })
    this.k.changed(classId)
    return this.load(classId, sessionId)
  }

  async submitCheck(classId: string, sessionId: string, kind: CheckKind, answer: string): Promise<Session> {
    if (!CHECK_KINDS.includes(kind)) throw userError('Unknown check.')
    const text = answer.trim().slice(0, 6000)
    if (!text) throw userError('Write your answer first. "I don\'t know" is a fine answer too.')
    const session = await this.load(classId, sessionId)
    if (session.endedAt) throw userError('This session has ended.')
    const prompt = session.prompts[kind]
    if (!prompt) throw userError('Open this check first.')
    const ctx = await this.k.context(classId)
    const topic = findTopic(ctx.curriculum, session.topicId)
    if (!topic) throw userError('That topic is not in the curriculum anymore.')
    const reading = session.brief?.readings.map((r) => `${ctx.sources.find((s) => s.meta.id === r.sourceId)?.meta.title ?? r.sourceId} [${r.section}]`).join('; ') ?? ''
    const verdict = await this.k.job(classId, 'Checking your answer', async () =>
      judgeCheck(
        { runtime: await this.k.runtime(), ctx },
        topic,
        kind,
        prompt,
        text,
        reading,
        session.attempts.filter((a) => a.kind === kind)
      )
    )
    const attempt: CheckAttempt = { id: newId('att'), kind, prompt, answer: text, at: nowIso(), verdict }
    await this.k.repo.lock(classId, async () => {
      const fresh = await this.load(classId, sessionId)
      const next = { ...fresh, attempts: [...fresh.attempts, attempt] }
      await this.save(classId, next)
      await this.k.repo.update(classId, 'progress', (p) => ({
        ...p,
        [session.topicId]: applyCheck(p[session.topicId] ?? emptyProgress(session.topicId), kind, verdict.result === 'pass', next)
      }))
      await this.k.refreshProgress(classId)
      await this.k.snapshotIndependence(classId)
    })
    this.k.changed(classId)
    return this.load(classId, sessionId)
  }

  /** Close the session, keeping only the records and terms the learner accepted. */
  async finish(classId: string, sessionId: string, acceptRecords: number[], acceptTerms: number[]): Promise<Session> {
    await this.k.repo.lock(classId, async () => {
      const session = await this.load(classId, sessionId)
      if (session.endedAt) return
      const wrap = session.wrap
      if (wrap) {
        const records = wrap.records.filter((_, i) => acceptRecords.includes(i))
        await appendRecords(this.k, classId, records, { sessionId, topicId: session.topicId })
        const terms = wrap.terms.filter((_, i) => acceptTerms.includes(i))
        if (terms.length) {
          await this.k.repo.update(classId, 'glossary', (list) => {
            const out: GlossaryTerm[] = [...list]
            for (const t of terms) {
              if (out.some((g) => g.term.toLowerCase() === t.term.trim().toLowerCase())) continue
              out.push({
                id: newId('term'),
                term: t.term.trim().slice(0, 120),
                definition: t.definition.trim().slice(0, 600),
                avoid: t.avoid.map((a) => a.trim()).filter(Boolean).slice(0, 6),
                addedAt: nowIso(),
                updatedAt: nowIso()
              })
            }
            return out
          })
        }
      }
      if (session.type === 'review') {
        const latest = CHECK_KINDS.map((k) => [...session.attempts].reverse().find((a) => a.kind === k)).filter(Boolean)
        const allPassed = latest.length > 0 && latest.every((a) => a?.verdict?.result === 'pass')
        await this.k.repo.update(classId, 'progress', (p) => (p[session.topicId] ? { ...p, [session.topicId]: applyReviewOutcome(p[session.topicId], allPassed) } : p))
      }
      await this.save(classId, { ...session, phase: 'wrap', endedAt: nowIso() })
      await this.k.refreshProgress(classId)
      await this.k.snapshotIndependence(classId)
      await this.k.touch(await this.k.repo.requireMeta(classId))
    })
    this.k.changed(classId)
    return this.load(classId, sessionId)
  }

  async abandon(classId: string, sessionId: string): Promise<void> {
    await this.k.repo.lock(classId, async () => {
      const session = await this.load(classId, sessionId)
      if (session.attempts.length) await this.save(classId, { ...session, endedAt: nowIso() })
      else await this.k.repo.update(classId, 'sessions', (list) => list.filter((s) => s.id !== sessionId))
      const meta = await this.k.repo.requireMeta(classId)
      if (meta.openLessonId === sessionId) await this.setOpen(classId, null)
    })
    this.k.changed(classId)
  }

  /**
   * Open a lesson in the class, or close the open one (null). The open lesson
   * shows over every chat and every tutor in the class sees it; closing keeps
   * the lesson in progress, to resume from the Lessons tab.
   */
  async open(classId: string, sessionId: string | null): Promise<void> {
    await this.k.repo.lock(classId, async () => {
      if (sessionId) await this.load(classId, sessionId)
      await this.setOpen(classId, sessionId)
    })
    this.k.changed(classId)
  }

  /** Callers hold the class lock. Not a content change, so the class keeps its place in the list. */
  private async setOpen(classId: string, sessionId: string | null): Promise<void> {
    const meta = await this.k.repo.requireMeta(classId)
    if ((meta.openLessonId ?? null) === sessionId) return
    const next = { ...meta }
    if (sessionId) next.openLessonId = sessionId
    else delete next.openLessonId
    await this.k.repo.writeMeta(next)
  }
}
