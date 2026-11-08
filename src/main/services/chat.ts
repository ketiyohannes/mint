import type { ChatCommand, ChoiceQuestion, CodeLanguage, CodeRunResult, QuizQuestion, Thread, ThreadMessage, WidgetAnswer } from '@shared/types'
import { allTopics, findTopic } from '@shared/curriculum'
import { intakeQuestions, makeExercise, makeQuiz, reviewCode, type StudyDraft } from '../jobs'
import type { ClassService } from './classes'
import type { DiagramService } from './diagrams'
import type { SessionService } from './sessions'
import type { SetupService } from './setup'
import { UNNAMED_CLASS } from './setup'
import type { SourceService } from './sources'
import type { ThreadService } from './threads'
import type { Kernel } from './kernel'
import { notice, userError, userMessage } from './kernel'
import { AgentError } from '../agents/types'

export interface ChatSendInput {
  classId: string
  /** Omit to start a new chat. */
  threadId?: string
  message: string
  streamId: string
  /** An unsent answer in the lesson's study box, for the tutor to see. */
  studyDraft?: StudyDraft
}

const COMMANDS: ChatCommand[] = ['quiz', 'code', 'diagram', 'lesson', 'plan']
const clip = (s: string, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/**
 * The class chat: the learner's main conversation with the tutor.
 *
 * Code owns the flow; models fill in content. The first message of a class
 * starts the intake (multiple-choice questions, like a coding agent asking
 * before it plans). After that, messages go to the tutor (with the help
 * ladder), and tools (quiz, code exercise, diagram, lesson, plan) post
 * interactive widgets into the conversation.
 */
export class ChatService {
  constructor(
    private readonly k: Kernel,
    private readonly threads: ThreadService,
    private readonly classes: ClassService,
    private readonly sessions: SessionService,
    private readonly setup: SetupService,
    private readonly sources: SourceService,
    private readonly diagrams: DiagramService
  ) {
    // The first plan is announced in the chat where the intake happened.
    setup.onPlanned = (classId) => this.announcePlan(classId)
  }

  async send(input: ChatSendInput): Promise<Thread> {
    const { classId } = input
    const message = String(input.message ?? '').trim().slice(0, 4000)
    if (!message) throw userError('Type (or say) your message first.')
    const meta = await this.k.repo.requireMeta(classId)
    if (input.threadId) await this.requireChat(classId, input.threadId)

    if (meta.stage === 'intake') {
      const all = await this.k.repo.read(classId, 'threads')
      const pending = findPendingQuestions(all)
      // Typing instead of picking options answers the open questions in the learner's own words.
      if (pending) return this.answerQuestions(classId, pending.thread.id, pending.message.id, { kind: 'questions', answers: {}, note: message })
      if (!all.some((t) => t.messages.some((m) => m.widget?.kind === 'questions'))) return this.startIntake(input, message)
    }

    if (input.threadId) return this.threads.send({ classId, threadId: input.threadId, message, streamId: input.streamId, studyDraft: input.studyDraft })
    return this.threads.create({ classId, anchor: { kind: 'general' }, message, streamId: input.streamId, studyDraft: input.studyDraft })
  }

  async answer(input: { classId: string; threadId: string; messageId: string; answer: WidgetAnswer }): Promise<Thread> {
    const { classId, threadId, messageId, answer } = input
    const thread = await this.requireChat(classId, threadId)
    const msg = thread.messages.find((m) => m.id === messageId)
    if (!msg?.widget) throw userError('That item is no longer in the chat.')
    if (msg.widget.kind !== answer?.kind) throw userError('That answer does not fit this item.')

    switch (answer.kind) {
      case 'questions':
        return this.answerQuestions(classId, threadId, messageId, answer)
      case 'quiz': {
        const w = msg.widget as Extract<NonNullable<ThreadMessage['widget']>, { kind: 'quiz' }>
        if (w.choices) throw userError('This quiz is already answered.')
        const choices = w.questions.map((_, i) => {
          const c = Number(answer.choices?.[i])
          return Number.isInteger(c) && c >= 0 && c < w.questions[i].options.length ? c : -1
        })
        return this.threads.patchWidget(classId, threadId, messageId, (x) => (x.kind === 'quiz' ? { ...x, choices } : x))
      }
      case 'code': {
        const w = msg.widget as Extract<NonNullable<ThreadMessage['widget']>, { kind: 'code' }>
        const code = String(answer.code ?? '').slice(0, 20_000)
        if (!code.trim()) throw userError('Write some code first.')
        const result = sanitizeRun(answer.result)
        const passed = result.tests.filter((t) => t.pass).length
        await this.threads.patchWidget(classId, threadId, messageId, (x) => (x.kind === 'code' ? { ...x, submission: { code, passed, total: result.tests.length } } : x))
        await this.threads.append(classId, threadId, [{ role: 'user', text: `Submitted my solution (${passed}/${result.tests.length} tests passing).` }])
        const ctx = await this.k.context(classId)
        return this.threads.streamReply(classId, threadId, String(answer.streamId), undefined, async (signal, onDelta) =>
          reviewCode({ runtime: await this.k.runtime(), ctx, signal }, w.exercise, code, result, onDelta)
        )
      }
      default:
        throw userError('Unknown answer.')
    }
  }

  /** Run a tool in a chat (a slash command, a composer action, or a tutor offer). */
  async command(input: { classId: string; threadId?: string; command: ChatCommand; arg?: string; streamId?: string }): Promise<Thread> {
    const { classId } = input
    const command = input.command
    if (!COMMANDS.includes(command)) throw userError('Unknown command.')
    const arg = clip(input.arg ?? '', 600)
    const meta = await this.k.repo.requireMeta(classId)
    if (input.threadId) await this.requireChat(classId, input.threadId)

    if (command === 'lesson') return this.threads.track(input.streamId, (signal) => this.startLesson(classId, input.threadId, arg, signal))

    const focus = arg || (await this.currentFocus(classId)) || meta.mission.topic || meta.title
    const label = { quiz: 'Quiz', code: 'Code exercise', diagram: 'Diagram', plan: 'Plan' }[command]
    const call = `/${command}${arg ? ` ${arg}` : ''}`
    const thread = input.threadId
      ? await this.threads.append(classId, input.threadId, [{ role: 'user', text: call }])
      : await this.threads.createChat(classId, `${label}: ${focus}`, [{ role: 'user', text: call }])

    try {
      return await this.threads.track(input.streamId, (signal) => this.runTool(classId, thread.id, command, focus, arg, signal))
    } catch (err) {
      if (isStopped(err)) {
        const note = command === 'plan' ? '_Stopped waiting._ The plan was already being revised; it still updates in the Lessons tab.' : '_Stopped._'
        return this.threads.append(classId, thread.id, [{ role: 'tutor', text: note }])
      }
      return this.threads.append(classId, thread.id, [{ role: 'tutor', text: `Sorry, that did not work: ${userMessage(err)}`, error: true }])
    }
  }

  private async runTool(classId: string, threadId: string, command: Exclude<ChatCommand, 'lesson'>, focus: string, arg: string, signal: AbortSignal): Promise<Thread> {
    const runtime = await this.k.runtime()
    switch (command) {
      case 'quiz': {
        const ctx = await this.k.context(classId)
        const out = await this.k.job(classId, 'Writing a quiz', () => makeQuiz({ runtime, ctx, signal }, focus))
        const questions = sanitizeQuiz(out.questions)
        if (!questions.length) throw userError('The quiz came back empty. Try again.')
        return this.threads.append(classId, threadId, [{ role: 'tutor', text: '', widget: { kind: 'quiz', title: clip(out.title, 120) || `Quiz: ${focus}`, questions } }])
      }
      case 'code': {
        const ctx = await this.k.context(classId)
        const language: CodeLanguage | null = /\b(js|javascript|node)\b/i.test(arg) ? 'javascript' : /\b(py|python)\b/i.test(arg) ? 'python' : null
        const out = await this.k.job(classId, 'Writing a code exercise', () => makeExercise({ runtime, ctx, signal }, focus, language))
        const exercise = {
          title: clip(out.title, 120) || 'Exercise',
          prompt: String(out.prompt ?? '').slice(0, 6000),
          language: out.language === 'javascript' ? ('javascript' as const) : ('python' as const),
          starter: String(out.starter ?? '').slice(0, 8000),
          tests: String(out.tests ?? '').slice(0, 8000),
          hint: clip(out.hint, 400) || undefined
        }
        return this.threads.append(classId, threadId, [{ role: 'tutor', text: '', widget: { kind: 'code', exercise } }])
      }
      case 'diagram': {
        const e = await this.diagrams.create(classId, focus, undefined, signal)
        return this.threads.append(classId, threadId, [{ role: 'tutor', text: '', widget: { kind: 'diagram', explorableId: e.id } }])
      }
      case 'plan': {
        const sources = await this.k.repo.read(classId, 'sources')
        if (!sources.length) throw userError('Add materials (or approve suggested sources) before planning.')
        // Planning is shared with the Lessons tab, so a stop only stops waiting for it.
        await this.setup.plan(classId, arg || 'Revise the plan based on my recent evidence and any new materials.')
        return this.appendPlan(classId, threadId, 'Updated plan:')
      }
    }
  }

  // -------------------------------------------------------------------------
  // Intake
  // -------------------------------------------------------------------------

  private async startIntake(input: ChatSendInput, message: string): Promise<Thread> {
    const { classId } = input
    const thread = input.threadId
      ? await this.threads.append(classId, input.threadId, [{ role: 'user', text: message }])
      : await this.threads.createChat(classId, message, [{ role: 'user', text: message }])
    try {
      const ctx = await this.k.context(classId)
      const out = await this.threads.track(input.streamId, (signal) =>
        this.k.job(classId, 'Reading your materials', async () => intakeQuestions({ runtime: await this.k.runtime(), ctx, signal }, message))
      )
      const questions = sanitizeQuestions(out.questions)
      if (ctx.meta.title === UNNAMED_CLASS && clip(out.title, 80)) await this.classes.update(classId, { title: clip(out.title, 80), mission: { ...ctx.meta.mission, topic: clip(out.title, 80) } })
      if (!questions.length) return this.answerQuestions(classId, thread.id, null, { kind: 'questions', answers: {}, note: '' })
      return this.threads.append(classId, thread.id, [{ role: 'tutor', text: clip(out.intro, 600), widget: { kind: 'questions', questions } }])
    } catch (err) {
      if (isStopped(err)) return this.threads.append(classId, thread.id, [{ role: 'tutor', text: '_Stopped._ Send another message when you are ready.' }])
      return this.threads.append(classId, thread.id, [
        { role: 'tutor', text: `Sorry, I could not get started: ${userMessage(err)}\n\nSend another message to try again.`, error: true }
      ])
    }
  }

  /**
   * Record the intake answers as the mission and context, then plan (or find
   * trusted sources first when the class has no materials) in the background.
   */
  private async answerQuestions(classId: string, threadId: string, messageId: string | null, answer: Extract<WidgetAnswer, { kind: 'questions' }>): Promise<Thread> {
    const thread = await this.requireChat(classId, threadId)
    const msg = messageId ? thread.messages.find((m) => m.id === messageId) : undefined
    const widget = msg?.widget?.kind === 'questions' ? msg.widget : undefined
    if (widget && (widget.answers || widget.skipped)) throw userError('These questions are already answered.')
    const questions = widget?.questions ?? []
    const skip = 'skip' in answer && answer.skip === true
    const answers: Record<string, string[]> = {}
    if (!skip && 'answers' in answer) {
      for (const q of questions) {
        const picked = (Array.isArray(answer.answers?.[q.id]) ? answer.answers[q.id] : []).map((a) => clip(a, 300)).filter(Boolean)
        if (picked.length) answers[q.id] = q.multiSelect ? picked.slice(0, 6) : picked.slice(0, 1)
      }
    }
    const note = !skip && 'note' in answer ? clip(answer.note ?? '', 2000) : ''

    if (msg && widget) await this.threads.patchWidget(classId, threadId, msg.id, (w) => (w.kind === 'questions' ? { ...w, answers, skipped: skip || undefined } : w))
    // The answered question card already shows picked options; only typed words become a message.
    if (note) await this.threads.append(classId, threadId, [{ role: 'user', text: note }])

    await this.recordIntake(classId, thread, questions, answers, note)
    const hasSources = (await this.k.repo.read(classId, 'sources')).length > 0
    const out = await this.threads.append(classId, threadId, [
      {
        role: 'tutor',
        text: hasSources
          ? 'Thanks. I am reading your materials and drafting a plan, which takes a minute. Meanwhile your sources are open in the panel: start skimming, or ask me anything.'
          : 'Thanks. You have not added materials, so I am searching trusted sites for good ones. You approve every source before I teach from it.'
      }
    ])
    void (hasSources ? this.setup.plan(classId) : this.findSources(classId, threadId)).catch((err) =>
      this.threads
        .append(classId, threadId, [{ role: 'tutor', text: `Sorry, planning failed: ${userMessage(err)}\n\nOpen the Lessons tab to try again.`, error: true }])
        .catch(() => notice(this.k, classId, 'Planning your curriculum', err))
    )
    return out
  }

  private async recordIntake(classId: string, thread: Thread, questions: ChoiceQuestion[], answers: Record<string, string[]>, note: string): Promise<void> {
    const first = thread.messages.find((m) => m.role === 'user')?.text ?? ''
    const lines = questions.filter((q) => answers[q.id]).map((q) => `${q.question} ${answers[q.id].join(', ')}`)
    const background = questions.find((q) => /background|experience|level|know/i.test(`${q.header} ${q.question}`))
    const meta = await this.k.repo.requireMeta(classId)
    await this.classes.update(classId, {
      mission: { ...meta.mission, why: clip([first, note].filter(Boolean).join(' '), 2000) || meta.mission.why },
      intake: {
        ...meta.intake,
        priorExperience: background && answers[background.id] ? answers[background.id].join(', ') : meta.intake.priorExperience,
        preferences: clip([...lines, note ? `In their words: ${note}` : ''].filter(Boolean).join('\n'), 2000)
      }
    })
    await this.k.repo.lock(classId, () =>
      this.k.repo.write(classId, 'diagnostic', {
        questions: questions.map((q) => q.question),
        answers: questions.map((q) => (answers[q.id] ?? []).join(', ')),
        result: {
          summary: lines.length || note ? `From the intake chat: ${[...lines, note].filter(Boolean).join(' ')}`.slice(0, 1000) : 'Intake skipped. The plan starts from the foundations and adapts as you go.',
          startingLevel: background && answers[background.id] ? answers[background.id].join(', ') : 'unknown',
          records: []
        }
      })
    )
    this.k.changed(classId)
  }

  private async findSources(classId: string, threadId: string): Promise<void> {
    await this.sources.proposeTrusted(classId)
    const proposals = (await this.k.repo.read(classId, 'proposals')).filter((p) => p.status === 'proposed')
    await this.threads.append(classId, threadId, [
      proposals.length
        ? { role: 'tutor', text: 'Here is what I found on trusted sites. Pick the ones you want to study from:', widget: { kind: 'sources' } }
        : { role: 'tutor', text: 'I could not find good trusted sources for this. Add your own materials from the Sources tab and I will plan from them.' }
    ])
  }

  private async announcePlan(classId: string): Promise<void> {
    const all = await this.k.repo.read(classId, 'threads')
    const target =
      all.find((t) => t.messages.some((m) => m.widget?.kind === 'questions')) ??
      [...all].filter((t) => t.anchor.kind === 'general').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    if (target) await this.appendPlan(classId, target.id, 'Your plan is ready.')
  }

  private async appendPlan(classId: string, threadId: string, lead: string): Promise<Thread> {
    const curriculum = await this.k.repo.read(classId, 'curriculum')
    if (!curriculum) throw userError('There is no plan yet.')
    const topics = allTopics(curriculum)
    return this.threads.append(classId, threadId, [
      {
        role: 'tutor',
        text: `${lead} ${topics.length} lesson${topics.length === 1 ? '' : 's'} in ${curriculum.milestones.length} part${curriculum.milestones.length === 1 ? '' : 's'}. ${curriculum.summary}`.trim(),
        widget: { kind: 'plan', version: curriculum.version }
      }
    ])
  }

  // -------------------------------------------------------------------------
  // Lessons
  // -------------------------------------------------------------------------

  private async startLesson(classId: string, threadId: string | undefined, arg: string, signal?: AbortSignal): Promise<Thread> {
    const ctx = await this.k.context(classId)
    if (!ctx.curriculum) throw userError('There is no plan yet. Answer the intake questions first.')
    const topics = allTopics(ctx.curriculum)
    const wanted = arg.toLowerCase()
    const topic =
      (arg && (findTopic(ctx.curriculum, arg) ?? topics.find((t) => t.title.toLowerCase() === wanted) ?? topics.find((t) => t.title.toLowerCase().includes(wanted)))) ||
      (ctx.curriculum && (await this.nextTopic(classId)))
    if (!topic) throw userError(arg ? `No lesson matches "${arg}".` : 'Every lesson is done. Review one from the Lessons tab, or extend the plan.')
    const type = ctx.progress[topic.id]?.status === 'mastered' ? 'review' : 'learn'
    const session = await this.sessions.start(classId, topic.id, type, signal)
    const text = `**${type === 'review' ? 'Review' : 'Lesson'}: ${topic.title}.** ${topic.objective}\n\nAsk me anything about it here.`
    if (threadId) return this.threads.append(classId, threadId, [{ role: 'tutor', text, widget: { kind: 'lesson', sessionId: session.id } }], { sessionId: session.id })
    return this.threads.createChat(classId, `${type === 'review' ? 'Review' : 'Lesson'}: ${topic.title}`, [{ role: 'tutor', text, widget: { kind: 'lesson', sessionId: session.id } }], session.id)
  }

  private async nextTopic(classId: string) {
    const b = await this.classes.get(classId)
    const id = b.reviewsDue[0] ?? b.nextTopicId
    return id ? findTopic(b.curriculum, id) : undefined
  }

  /** What the learner is working on now: the open lesson's topic, else the latest unfinished one, else the next one. */
  private async currentFocus(classId: string): Promise<string> {
    const [meta, sessions, curriculum] = await Promise.all([this.k.repo.requireMeta(classId), this.k.repo.read(classId, 'sessions'), this.k.repo.read(classId, 'curriculum')])
    const unfinished = sessions.filter((s) => !s.endedAt)
    const open = unfinished.find((s) => s.id === meta.openLessonId) ?? unfinished.at(-1)
    const topic = open ? findTopic(curriculum, open.topicId) : await this.nextTopic(classId)
    return topic ? `${topic.title}: ${topic.objective}` : ''
  }

  private async requireChat(classId: string, threadId: string): Promise<Thread> {
    const t = (await this.k.repo.read(classId, 'threads')).find((x) => x.id === threadId)
    if (!t) throw userError('That chat no longer exists.')
    return t
  }
}

function findPendingQuestions(threads: Thread[]): { thread: Thread; message: ThreadMessage } | null {
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.widget?.kind === 'questions' && !message.widget.answers && !message.widget.skipped) return { thread, message }
    }
  }
  return null
}

function sanitizeQuestions(raw: { header: string; question: string; multiSelect: boolean; options: { label: string; description: string }[] }[]): ChoiceQuestion[] {
  return (raw ?? [])
    .map((q, i) => ({
      id: `q${i + 1}`,
      header: clip(q.header, 12) || `Q${i + 1}`,
      question: clip(q.question, 300),
      multiSelect: Boolean(q.multiSelect),
      options: (q.options ?? [])
        .map((o) => ({ label: clip(o.label, 80), description: clip(o.description, 200) || undefined }))
        .filter((o) => o.label && !/^other\b/i.test(o.label))
        .slice(0, 5)
    }))
    .filter((q) => q.question && q.options.length >= 2)
    .slice(0, 4)
}

function sanitizeQuiz(raw: QuizQuestion[]): QuizQuestion[] {
  return (raw ?? [])
    .map((q) => ({
      prompt: String(q.prompt ?? '').slice(0, 1000),
      options: (q.options ?? []).map((o) => String(o).slice(0, 400)).slice(0, 6),
      answer: Number(q.answer),
      explanation: String(q.explanation ?? '').slice(0, 1500)
    }))
    .filter((q) => q.prompt.trim() && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length)
    .slice(0, 8)
}

function sanitizeRun(r: CodeRunResult | undefined): CodeRunResult {
  return {
    ok: Boolean(r?.ok),
    output: (Array.isArray(r?.output) ? r!.output : []).map((l) => String(l).slice(0, 500)).slice(0, 60),
    tests: (Array.isArray(r?.tests) ? r!.tests : []).slice(0, 30).map((t) => ({ name: clip(t?.name, 200), pass: Boolean(t?.pass), message: t?.message ? clip(t.message, 500) : undefined })),
    error: r?.error ? String(r.error).slice(0, 2000) : undefined
  }
}

function isStopped(err: unknown): boolean {
  return err instanceof AgentError && err.kind === 'aborted'
}
