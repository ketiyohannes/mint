import { PHASE_LABEL } from '@shared/depth'
import { CODE_LANGUAGES, languageFromName, languageLabel, type LanguageId } from '@shared/languages'
import type {
  Anchor,
  CodeExercise,
  CodeLanguage,
  CodeRunResult,
  Brief,
  CheckAttempt,
  CheckKind,
  Diagnostic,
  DiagramSpec,
  Explorable,
  NoteDoc,
  Rung,
  Session,
  Thread,
  Topic,
  Verdict
} from '@shared/types'
import type { AgentRuntime } from '../agents/types'
import { describeClass, describeTopic, type ClassContext } from './context'
import { tutor } from './format'
import { runStructured, runText } from './run'
import {
  BriefSchema,
  CheckPromptSchema,
  CurriculumSchema,
  DiagnosticQuestionsSchema,
  DiagnosticResultSchema,
  DiagramSchema,
  ExerciseSchema,
  GlossaryCheckSchema,
  IntakeQuestionsSchema,
  QuizSchema,
  ReferenceDraftSchema,
  SourceProposalsSchema,
  VerdictSchema,
  WrapSchema,
  type CurriculumOutput,
  type ExerciseOutput,
  type IntakeQuestionsOutput,
  type QuizOutput
} from './schemas'
import * as demo from './demo'
import { DIAGRAM_CONTRACT } from './diagramContract'

export interface JobEnv {
  runtime: AgentRuntime
  ctx: ClassContext
  signal?: AbortSignal
}

const base = (env: JobEnv) => ({ cwd: env.ctx.dir, signal: env.signal })

// ---------------------------------------------------------------------------
// Trusted-source curriculum (no materials brought)
// ---------------------------------------------------------------------------

export function proposeSources(env: JobEnv, focus: string | undefined, existingUrls: string[]) {
  const domains = env.ctx.meta.trustedDomains
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'propose-sources',
    readFiles: false,
    web: { allowedDomains: domains },
    effort: 'medium',
    maxTurns: 24,
    system: `${tutor('sources', 'wisdom')}

Your job now: find high-trust public sources the learner will actually study from, because they did not bring (enough) materials of their own. Only use these trusted domains: ${domains.join(', ')}. YouTube is allowed for strong lectures or explainers from reputable channels.
Rules:
- Search the web, then propose 4 to 8 sources that together cover the mission at the right level. Prefer primary or canonical texts, university course notes, and well-known explainers.
- Every URL must be a real page you saw in search results or fetched. Never invent URLs. Use the canonical page URL (no tracking parameters).
- For YouTube use the watch URL (https://www.youtube.com/watch?v=...). kind is "youtube" for videos, otherwise "web".
- "why" says in one sentence why this source is trustworthy; "covers" says what part of the mission it covers.`,
    prompt: `${describeClass(env.ctx, { includeRecords: false })}

${focus ? `Focus for this search: ${focus}\n` : ''}${existingUrls.length ? `Already in the library (do not repeat): ${existingUrls.join(', ')}\n` : ''}Propose the sources now.`,
    schema: SourceProposalsSchema,
    demo: () => demo.sourceProposals(env.ctx)
  })
}

// ---------------------------------------------------------------------------
// Intake: diagnostic + curriculum
// ---------------------------------------------------------------------------

export function diagnosticQuestions(env: JobEnv) {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'diagnostic-questions',
    readFiles: true,
    effort: 'low',
    system: `${tutor('diagnostics')}

Your job now: write a short diagnostic (3 or 4 questions) to estimate what the learner already knows before planning. Mix: one question about prior experience with the core ideas, one or two recall/explain questions on foundational ideas from the materials, and one tiny application task. Never infer level from confidence alone. Questions must be answerable in 1 to 3 sentences, and it must be fine to answer "I don't know".`,
    prompt: `${describeClass(env.ctx)}\n\nSkim the sources' structure, then write the diagnostic questions.`,
    schema: DiagnosticQuestionsSchema,
    demo: () => demo.diagnosticQuestions(env.ctx)
  })
}

export function assessDiagnostic(env: JobEnv, diag: Diagnostic) {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'diagnostic-assess',
    readFiles: true,
    effort: 'low',
    system: `${tutor('diagnostics', 'records')}

Your job now: read the learner's diagnostic answers and estimate their starting point. Write learning records ONLY for real evidence: demonstrated understanding (kind "understanding"), explicitly stated prior knowledge (kind "prior-knowledge", include the claimed depth), or a misconception you can see (kind "misconception"). "I don't know" produces no record. Each record: short title, 1 to 3 sentence body saying what is known and why it matters for teaching, and the evidence (quote their answer).`,
    prompt: `${describeClass(env.ctx)}

Diagnostic:
${diag.questions.map((q, i) => `Q${i + 1}: ${q}\nA${i + 1}: ${diag.answers[i]?.trim() || '(no answer)'}`).join('\n\n')}

Assess it now. "startingLevel" is a short phrase like "new to the topic" or "comfortable with the basics, shaky on proofs".`,
    schema: DiagnosticResultSchema,
    demo: () => demo.diagnosticResult(diag)
  })
}

export function planCurriculum(env: JobEnv, diag: Diagnostic | null, reason: string): Promise<CurriculumOutput> {
  const previous = env.ctx.curriculum
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'plan-curriculum',
    readFiles: true,
    effort: 'high',
    maxTurns: 30,
    system: `${tutor('intake', 'curriculum', 'sources')}

Your job now: design (or revise) the curriculum map for this class.
- Anchor it in a small, meaningful project with a concrete deliverable tied to the mission when one fits the learner's time. If the class is pure knowledge (e.g. understanding one paper), use the deliverable "explain it to someone in your own words" and set project to null.
- Milestones (2 to 5) each produce a deliverable. Topics (2 to 5 per milestone) are single skills or ideas that fit one study session.
- Every topic must cite where to read it: sources[].sourceId must be a real source id, and sources[].section must be a section label exactly as written in the "## [label]" headings of that source's content.md. Read the files to choose good sections.
- prerequisites lists earlier topic ids only (ids are short kebab-case slugs you choose).
- practice: one concrete practice task; gate: what the learner must show (explain, apply to a new case, distinguish from nearby ideas).
- Respect the mission's out-of-scope list and time constraints. Make assumptions explicit in "assumptions".
- Skip or compress what learning records show the learner already knows; branch into prerequisites where they show gaps.
${previous ? '- This is a REVISION: keep topic ids and titles that still make sense, so progress carries over. Change only what the evidence calls for.' : ''}`,
    prompt: `${describeClass(env.ctx, { includeCurriculum: true })}
${diag?.result ? `\nDiagnostic summary: ${diag.result.summary} (starting level: ${diag.result.startingLevel})` : ''}
${previous ? `\nCurrent curriculum (v${previous.version}) for reference:\n${JSON.stringify(previous.milestones.map((m) => ({ title: m.title, topics: m.topics.map((t) => ({ id: t.id, title: t.title, prerequisites: t.prerequisites })) })))}` : ''}

Reason for this plan: ${reason}
Write the curriculum now.`,
    schema: CurriculumSchema,
    demo: () => demo.curriculum(env.ctx)
  })
}

// ---------------------------------------------------------------------------
// Study session
// ---------------------------------------------------------------------------

export function writeBrief(env: JobEnv, topic: Topic, type: Session['type']): Promise<Brief> {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'session-brief',
    readFiles: true,
    effort: 'medium',
    system: `${tutor('lessons', 'sources')}

Your job now: write the brief that starts a ${type === 'review' ? 'REVIEW (retrieval practice, spaced repetition)' : 'study'} session.
- "win": the single tangible thing the learner will be able to do after this session (one sentence).
- "whyItMatters": one or two sentences tying it to their mission.
- "readings": 1 to 3 precise places to read (sourceId + exact section label + a note on what to look for). ${type === 'review' ? 'For a review, list where to check answers AFTER recalling.' : ''}
- "questions": 2 or 3 questions the learner should be able to answer FROM THE READING. They read with these in mind, so make them specific and answerable from the passages, not trivia.
Stay inside the learner's zone of proximal development: use the learning records to pitch it.`,
    prompt: `${describeClass(env.ctx)}

${describeTopic(env.ctx, topic)}

Read the planned sections, then write the brief.`,
    schema: BriefSchema,
    demo: () => demo.brief(env.ctx, topic)
  })
}

/** A check's question, and the language to answer in when it asks for code (null: a written answer). */
export interface CheckQuestion {
  prompt: string
  language: LanguageId | null
}

/** What a check asks for depends on the subject: prose is one form of answer, not the only one. */
const CHECK_FORM = `Fit the task to the subject. A written paragraph is one form of answer, not the default:
- Programming, algorithms, data structures, systems, or anything the learner will do in code: ask for code. A small function to write, a bug to find and fix, a snippet to complete, or output to predict and then explain. Use the language of their materials or their mission. It must be solvable in about 25 lines with only the standard library, and readable without running it. Put any code you give in a fenced block with its language.
- Mathematics and other quantitative subjects: ask for a worked calculation, a derivation step or a short proof, with concrete numbers.
- Anything else: a short written answer.
Fields:
- "prompt": the task, in 1 to 4 sentences (plus a short code block or formula when the task needs one). Do not include the answer or hints.
- "answer": "code" when the learner should answer mainly in code, otherwise "text".
- "language": for a code answer, one of ${CODE_LANGUAGES.map((l) => `"${l.id}"`).join(', ')} ("plain" for pseudocode or any other language). For a text answer, "".`

export async function checkPrompt(env: JobEnv, topic: Topic, brief: Brief | undefined, kind: CheckKind): Promise<CheckQuestion> {
  if (kind === 'explain' && brief?.questions.length) {
    // Explain-back uses the brief's own questions: the learner read with them in mind.
    return { prompt: `Without looking back at the text, explain in your own words:\n\n${brief.questions.map((q) => `- ${q}`).join('\n')}`, language: null }
  }
  const what =
    kind === 'explain'
      ? 'an explain-back prompt: ask the learner to explain the core idea in their own words, as if teaching a friend'
      : kind === 'apply'
        ? 'an application task: a NEW concrete case (numbers, a scenario, a small problem, a piece of code to write or fix, or the next step of their project) that requires using the idea, not restating it. Not a case from the reading.'
        : 'a distinguish prompt: ask how this idea differs from one or two nearby ideas it is easily confused with (name them), and when each applies. For a subject done in code, the difference may be shown with two short snippets.'
  const out = await runStructured(env.runtime, {
    ...base(env),
    purpose: `check-prompt-${kind}`,
    readFiles: true,
    effort: 'low',
    system: `${tutor('practice', 'diagnostics')}\n\nYour job now: write ${what}.\n\n${CHECK_FORM}`,
    prompt: `${describeClass(env.ctx)}\n\n${describeTopic(env.ctx, topic)}\n\nWrite the prompt now.`,
    schema: CheckPromptSchema,
    demo: () => demo.checkPrompt(topic, kind)
  })
  // The model names a language; code decides which of ours it is. One we do not know is written as plain text.
  return { prompt: out.prompt.trim(), language: out.answer === 'code' ? (languageFromName(out.language) ?? 'plain') : null }
}

/**
 * Judges an answer to a check. `earlier` holds the learner's previous tries at
 * this same check, with the verdicts they got: a retry is a repair of those,
 * judged with them in view rather than from scratch.
 */
export function judgeCheck(env: JobEnv, topic: Topic, kind: CheckKind, prompt: string, answer: string, rubricHint: string, earlier: CheckAttempt[] = []): Promise<Verdict> {
  const tries = earlier
    .map(
      (a, i) =>
        `Try ${i + 1}:\n${a.answer}\nYour verdict: ${a.verdict?.result ?? 'n/a'}${a.verdict ? `\nYour feedback: ${a.verdict.feedback}` : ''}${a.verdict?.misconceptions.length ? `\nMisconceptions you named: ${a.verdict.misconceptions.join('; ')}` : ''}`
    )
    .join('\n\n')
  return runStructured(env.runtime, {
    ...base(env),
    purpose: `judge-${kind}`,
    readFiles: true,
    effort: 'medium',
    system: `${tutor('diagnostics', 'practice')}

Your job now: judge one ${kind === 'explain' ? 'explain-back' : kind === 'apply' ? 'application' : 'distinguish'} answer against the learner's materials.
- "pass": accurate and in their own words, covering the core idea; small slips are fine.
- "partial": on the right track but missing a key step or with an imprecision that matters.
- "fail": wrong, missing the core idea, or just restating the question. "I don't know" is fail (that is fine and useful).
- feedback (markdown, at most 120 words): name what was right, then the single most important gap or misconception, and send them to the exact passage to fix it with a [[cite:...]] directive. Do not give a full model answer; the learner should do the repair.
- misconceptions: short phrases for any wrong beliefs you can see (empty if none).
- Code in the answer comes in fenced blocks. You cannot run it: read it, and trace it by hand on one small input and on any edge case the task names. Judge whether it does what the task asks. A slip a compiler would catch at once (a missing semicolon, a misspelled name) is a small slip unless the task is about syntax; style is not a reason to fail. To point at a line, quote that line in a fenced block; never write the corrected solution.
- When the task asked for code and the answer is only prose (or the other way round), judge what it shows and say which form the task needs.
When there are earlier tries, this answer is the learner's repair after your feedback. Judge what they understand now, reading it together with their earlier tries: credit what they already got right (they need not repeat it), and judge whether they fixed the gap you named. Make your feedback continue from your earlier feedback: acknowledge the repair, and do not repeat a pointer they have already acted on. Misconceptions are the ones still present.
Be honest; never pass an answer just to be encouraging.`,
    prompt: `${describeClass(env.ctx, { includeRecords: false })}

${describeTopic(env.ctx, topic)}
${rubricHint ? `\nWhat the learner read: ${rubricHint}` : ''}

Prompt given to the learner:
${prompt}
${tries ? `\nEarlier tries at this check, oldest first:\n\n${tries}\n` : ''}
${tries ? "Learner's new try" : "Learner's answer"}:
${answer.trim() || '(empty)'}

Check the relevant passages, then judge.`,
    schema: VerdictSchema,
    demo: () => demo.verdict(answer, kind, earlier)
  })
}

export function wrapSession(env: JobEnv, topic: Topic, session: Session) {
  const transcript = session.attempts
    .map(
      (a) =>
        `[${a.kind}] Prompt: ${a.prompt}\nAnswer: ${a.answer}\nVerdict: ${a.verdict?.result ?? 'n/a'}${a.verdict?.misconceptions.length ? ` (misconceptions: ${a.verdict.misconceptions.join('; ')})` : ''}`
    )
    .join('\n\n')
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'session-wrap',
    readFiles: false,
    effort: 'low',
    system: `${tutor('records', 'glossary')}

Your job now: close the session the way the /teach method does.
- summary: 2 sentences on what the learner showed, written to them ("you").
- records: learning records ONLY for decision-grade evidence from this session: genuine understanding demonstrated (passed checks), a misconception corrected, or a stated piece of prior knowledge. Coverage is not learning; if nothing qualifies, return an empty list. Each needs evidence quoting the learner.
- terms: glossary candidates ONLY for terms the learner used correctly in their own answers. Definition: one or two tight sentences in the learner's own wording where possible. "avoid": looser synonyms to avoid. Skip terms already in their glossary.`,
    prompt: `${describeClass(env.ctx)}

${describeTopic(env.ctx, topic)}

Session (${session.type}):
${transcript || '(no checks were attempted)'}

Write the wrap-up now.`,
    schema: WrapSchema,
    demo: () => demo.wrap(topic, session)
  })
}

// ---------------------------------------------------------------------------
// Ask threads (the margin tutor), with the help ladder enforced per rung
// ---------------------------------------------------------------------------

const RUNG_RULES: Record<Rung, string> = {
  1: `HELP RUNG 1 (POINTER). Do not explain and do not answer. In at most 60 words, point to the exact passage(s) in their materials that answer this, using [[cite:...]] directives, and say in one sentence what to look for there.`,
  2: `HELP RUNG 2 (GUIDING QUESTION). Do not state the answer. In at most 90 words, ask one or two guiding questions that lead the learner to work it out from the passage, and cite the passage with [[cite:...]].`,
  3: `HELP RUNG 3 (HINT). Give a partial hint that unlocks the next step (a key relation, an analogy, or the first step) but leave the conclusion to the learner. At most 130 words. Cite the passage with [[cite:...]].`,
  4: `EXPLAIN LIKE A TEACHER. Teach the idea completely, in your own words and in plain, friendly English. Never answer by pointing to the materials or restating them: first read what their materials say, then digest it for the learner.
- Open with the answer or the main idea in one or two plain sentences, so the learner has it before the detail.
- Then build it from the problem it answers (the method under "How to explain an idea"): what was needed, the natural first try and where it breaks, the idea as the fix, and the exact statement last.
- When you reach the exact statement, take it apart: every symbol of a formula and every condition of a definition, each with what it is for.
- Work through one small, concrete example step by step; add a second, contrasting one only when it sharpens the idea.
- Connect it to what the learner already knows and to their mission, and clear up the usual confusion before it happens.
- Go beyond the materials when it helps understanding (another angle, an analogy, where it is used), labeling what is outside their materials.
- Cite the passages you build on with [[cite:...]], woven into the explanation as references; a citation never replaces explaining.
Take the space the idea needs and no more: short paragraphs, headings or numbered steps only for longer answers, no padding, and a short answer for a small question. End with one short question that checks understanding.`
}

const MAIN_CHAT_RULES = `You are the tutor in the class's main chat. The learner's materials are open in a viewer beside the chat.
You have tools you can OFFER as buttons (the learner clicks to run them); offer at most one per reply, and only when it would genuinely help practice or see the idea:
- [[offer:quiz|<focus>]] a short multiple-choice quiz on <focus>
- [[offer:code|<focus>]] a small coding exercise on <focus> (only if the subject involves code, algorithms or computation)
- [[offer:diagram|<what to draw>]] an interactive diagram`

export interface ThreadContext {
  thread: Thread
  rung: Rung
  /** Text around the anchor (for source anchors) or the quoted message. */
  anchorContext: string
  explorable?: Explorable
  sessionTopic?: Topic
  /** The class's open lesson, whichever chat it started in: what the learner sees in its study box. */
  session?: Session
  /** That lesson's steps, at the study depth in Settings. */
  sessionSteps?: Session['phase'][]
  /** An answer the learner is writing in the study box but has not submitted. */
  studyDraft?: StudyDraft
}

export interface StudyDraft {
  kind: CheckKind
  text: string
}

const STEP_LABEL = PHASE_LABEL
const VERDICT_LABEL: Record<Verdict['result'], string> = { pass: 'Pass', partial: 'Almost', fail: 'Not yet' }
const quoted = (s: string, n: number) => {
  const t = s.trim()
  return `"${t.length > n ? `${t.slice(0, n)}…` : t}"`
}

/**
 * The lesson's study box as the learner sees it (brief, steps, checks, their
 * answers and the feedback), so they can talk about any of it in the chat.
 */
export function describeStudyBox(ctx: ClassContext, session: Session, topic: Topic | undefined, draft?: StudyDraft, phases: Session['phase'][] = PHASES_IN_ORDER): string {
  const sourceTitle = (id: string) => ctx.sources.find((s) => s.meta.id === id)?.meta.title ?? id
  const steps = phases.map((p) => (p === session.phase ? `${STEP_LABEL[p]} (current)` : STEP_LABEL[p])).join(' → ')
  const lines = [
    `## The study box (the class's open lesson, shown with this chat; the learner sees exactly this)`,
    `${session.type === 'review' ? 'Review' : 'Lesson'}: ${topic?.title ?? session.topicId}${topic ? `. Objective: ${topic.objective}` : ''}`,
    session.endedAt ? 'The lesson is finished.' : `Steps: ${steps}`
  ]
  const b = session.brief
  if (b) {
    lines.push('', '### Brief', `The win: ${b.win}`, `Why it matters: ${b.whyItMatters}`)
    if (b.readings.length) lines.push(`Readings: ${b.readings.map((r) => `${sourceTitle(r.sourceId)} [${r.section}]${r.note ? ` (${r.note})` : ''}`).join('; ')}`)
    if (b.questions.length) lines.push('Read with these questions in mind:', ...b.questions.map((q, i) => `${i + 1}. ${q}`))
  }
  for (const kind of CHECK_ORDER) {
    const prompt = session.prompts[kind]
    const attempts = session.attempts.filter((a) => a.kind === kind)
    const unsent = draft?.kind === kind && draft.text.trim() ? draft.text : ''
    if (!prompt && !attempts.length && !unsent) continue
    const passed = attempts.some((a) => a.verdict?.result === 'pass')
    lines.push('', `### ${STEP_LABEL[kind]} check (${passed ? 'passed' : 'not passed yet'})`)
    if (prompt) lines.push(`Question: ${prompt}`)
    const language = session.codeChecks?.[kind]
    if (language) lines.push(`The answer box is a code editor (${languageLabel(language)}); the learner can add text to it.`)
    attempts.forEach((a, i) => {
      lines.push(`Attempt ${i + 1}: ${quoted(a.answer, 1500)}`)
      if (a.verdict) {
        lines.push(`Feedback (${VERDICT_LABEL[a.verdict.result]}): ${a.verdict.feedback.trim().slice(0, 1200)}`)
        if (a.verdict.misconceptions.length) lines.push(`Watch out: ${a.verdict.misconceptions.join('; ')}`)
      }
    })
    if (unsent) lines.push(`Being written now, not submitted yet: ${quoted(unsent, 2000)}`)
  }
  if (session.wrap?.summary) lines.push('', '### Wrap-up', session.wrap.summary)
  return lines.join('\n')
}

const PHASES_IN_ORDER: Session['phase'][] = ['brief', 'read', 'explain', 'apply', 'distinguish', 'wrap']
const CHECK_ORDER: CheckKind[] = ['explain', 'apply', 'distinguish']

const STUDY_BOX_RULES = `The learner may point at anything in the study box ("this question", "my answer", "the feedback"); you can see it, so answer about it directly. For a check they have not passed yet, coach them toward their own answer instead of writing it for them (the help rung still decides how much you say), and judge a draft honestly against the question and their readings.`

export function tutorReply(env: JobEnv, t: ThreadContext, onDelta: (d: string) => void): Promise<string> {
  const { thread, rung } = t
  const anchor = describeAnchor(thread.anchor, t)
  const history = thread.messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'Learner' : 'Tutor'}${m.rung ? ` (rung ${m.rung})` : ''}: ${m.text}`)
    .join('\n\n')
  const diagramRules = t.explorable
    ? `\nThe learner is looking at the interactive diagram "${t.explorable.spec.title}". Its parts: ${t.explorable.spec.elements.map((e) => `${e.id} (${e.label})`).join(', ')}. Its sliders: ${t.explorable.spec.params.map((p) => `${p.id} (${p.label}, ${p.min} to ${p.max}, now ${p.value})`).join(', ') || 'none'}.
Point at parts while you talk: put [[highlight:<elementId>]] right where you mention a part, and [[set:<paramId>=<value>]] where moving a slider helps. Use only the ids above.`
    : ''
  const studyBox = t.session ? `\n\n${describeStudyBox(env.ctx, t.session, t.sessionTopic, t.studyDraft, t.sessionSteps)}` : ''
  return runText(env.runtime, {
    ...base(env),
    purpose: `tutor-rung-${rung}`,
    readFiles: true,
    effort: rung === 4 ? 'medium' : 'low',
    onDelta,
    system: `${tutor('help', 'wisdom')}

${thread.anchor.kind === 'general' ? MAIN_CHAT_RULES : 'You are answering in a small Ask popover next to what the learner is reading.'} ${RUNG_RULES[rung]}
If the materials do not cover the question, say so in one sentence, then teach it anyway from general knowledge, labeled "outside your materials".${diagramRules}${t.session ? `\n${STUDY_BOX_RULES}` : ''}`,
    prompt: `${describeClass(env.ctx)}${studyBox}

${anchor}

Conversation so far:
${history}

Reply to the learner's last message now, following the help rung exactly.`,
    demo: () => demo.tutorReply(t)
  })
}

function describeAnchor(anchor: Anchor, t: ThreadContext): string {
  switch (anchor.kind) {
    case 'source':
      return `The learner highlighted this passage in source ${anchor.sourceId}, section [${anchor.sectionLabel}]:\n"${anchor.quote}"\n\nSurrounding text:\n${t.anchorContext}`
    case 'message':
      return `The learner highlighted part of an earlier tutor reply:\n"${anchor.quote}"\n\nThat reply in full:\n${t.anchorContext}`
    case 'diagram':
      return `The learner clicked the part "${anchor.label}" (id ${anchor.elementId}) of the diagram "${t.explorable?.spec.title ?? ''}". ${t.explorable?.spec.elements.find((e) => e.id === anchor.elementId)?.description ?? ''}`
    case 'general':
      return anchor.context ? `Context: ${anchor.context}` : 'General question about the class.'
  }
}

// ---------------------------------------------------------------------------
// Chat tools: intake questions, quizzes, code exercises
// ---------------------------------------------------------------------------

/** The first exchange of a class: ask what the learner wants, the way a coding agent asks clarifying questions. */
export function intakeQuestions(env: JobEnv, firstMessage: string): Promise<IntakeQuestionsOutput> {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'intake-questions',
    readFiles: true,
    effort: 'low',
    system: `${tutor('intake')}

Your job now: the learner just opened a new class and wrote their first message. Before planning, ask 2 to 4 short multiple-choice questions to learn their mission (why, and what success looks like), their prior experience, their time and constraints, and how they like to learn. Ask only what you cannot infer from their message and materials.
- header: a chip label of at most 12 characters ("Goal", "Background", "Time", "Style").
- question: one clear sentence ending with "?".
- options: 2 to 4 concrete, mutually exclusive choices (or combinable when multiSelect is true), each with a one-line description. The learner can always type their own answer instead, so do not add an "Other" option.
- intro: one or two friendly sentences acknowledging what they want and what you saw in their materials (no questions here).
- title: a 2 to 5 word name for the class (the subject, e.g. "Linear algebra for ML").`,
    prompt: `${describeClass(env.ctx, { includeRecords: false })}

Learner's first message:
${firstMessage}

Skim the materials' structure, then write the questions.`,
    schema: IntakeQuestionsSchema,
    demo: () => demo.intakeQuestions(env.ctx, firstMessage)
  })
}

export function makeQuiz(env: JobEnv, focus: string): Promise<QuizOutput> {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'quiz',
    readFiles: true,
    effort: 'low',
    system: `${tutor('practice')}

Your job now: write a short retrieval-practice quiz (3 to 5 questions) grounded in the learner's materials. Each question has exactly 4 options and one correct answer (answer is its 0-based index). Distractors must be plausible misconceptions, not jokes. Options of one question have about the same length and form, and the correct option's position varies across questions. Mix recall, application to a new case, and distinguishing close ideas. "explanation": 1 or 2 sentences on why the answer is right, ending with a [[cite:...]] to the passage.`,
    prompt: `${describeClass(env.ctx)}

Focus: ${focus}

Write the quiz now.`,
    schema: QuizSchema,
    demo: () => demo.quiz(env.ctx, focus)
  })
}

export function makeExercise(env: JobEnv, focus: string, language: CodeLanguage | null): Promise<ExerciseOutput> {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'code-exercise',
    readFiles: true,
    effort: 'medium',
    system: `${tutor('practice')}

Your job now: write ONE small coding exercise (10 to 30 lines to solve) that makes the learner apply an idea from their materials. It runs offline in a sandbox with no packages and no network.
- language: ${language ? `"${language}"` : '"python" unless the materials are about JavaScript or the web, then "javascript"'}.
- prompt: markdown task statement, with the function signature to implement and one example. Cite the passage it practices with [[cite:...]].
- starter: code with the function signature and a body that does not solve it (e.g. "pass" or "return null"), plus short comments.
- tests: 3 to 5 tests that call the learner's function. JavaScript: \`test('name', () => { assertEqual(actual, expected) })\` (assert(cond, msg) also exists). Python: functions named test_* using plain assert with a helpful message. Tests must pass with a correct solution and fail with the starter.
- hint: one sentence that nudges without giving the solution.`,
    prompt: `${describeClass(env.ctx, { includeRecords: false })}

Focus: ${focus}

Write the exercise now.`,
    schema: ExerciseSchema,
    demo: () => demo.exercise(focus, language)
  })
}

export function reviewCode(env: JobEnv, exercise: CodeExercise, code: string, result: CodeRunResult, onDelta: (d: string) => void): Promise<string> {
  const passed = result.tests.filter((t) => t.pass).length
  return runText(env.runtime, {
    ...base(env),
    purpose: 'code-review',
    readFiles: true,
    effort: 'low',
    onDelta,
    system: `${tutor('practice', 'help')}

Your job now: review the learner's solution to a coding exercise. Do not rewrite their code or give a full solution. In at most 150 words: say whether it is correct (trust the test results), point out the single most important issue (bug, edge case, or clarity), connect it back to the idea in their materials with [[cite:...]], and if tests fail give one hint toward the fix. Use a short fenced code block only to point at a specific line.`,
    prompt: `Exercise: ${exercise.title}
${exercise.prompt}

Learner's ${exercise.language} code:
\`\`\`${exercise.language}
${code.slice(0, 8000)}
\`\`\`

Test results: ${passed}/${result.tests.length} passed.
${result.tests.map((t) => `- ${t.pass ? 'PASS' : 'FAIL'} ${t.name}${t.message ? `: ${t.message}` : ''}`).join('\n')}
${result.error ? `Error: ${result.error}` : ''}
${result.output.length ? `Output:\n${result.output.slice(0, 40).join('\n')}` : ''}`,
    demo: () => demo.codeReview(passed, result.tests.length)
  })
}

// ---------------------------------------------------------------------------
// Glossary: the learner defines; the tutor checks against the sources
// ---------------------------------------------------------------------------

export function checkGlossaryTerm(env: JobEnv, term: string, definition: string, context: string) {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'glossary-check',
    readFiles: true,
    effort: 'low',
    system: `${tutor('glossary')}

Your job now: the learner wants to add a term to their glossary, defined in their own words. A term is added only when the learner understands it.
- accepted: true only if the definition is correct per their materials (minor wording issues are fine).
- feedback: one or two sentences. If not accepted, say what is off and cite where to check with [[cite:...]], without giving the definition away.
- definition: if accepted, a tightened version that keeps the learner's own wording (1 or 2 sentences, says what the term IS). If not accepted, return their text unchanged.
- avoid: looser synonyms to avoid (may be empty).`,
    prompt: `${describeClass(env.ctx, { includeRecords: false })}\n\nTerm: ${term}\nLearner's definition: ${definition}\n${context ? `Where they met it: ${context}\n` : ''}\nCheck it now.`,
    schema: GlossaryCheckSchema,
    demo: () => demo.glossaryCheck(term, definition)
  })
}

// ---------------------------------------------------------------------------
// Interactive diagrams
// ---------------------------------------------------------------------------

export function createDiagram(env: JobEnv, request: string, anchorContext: string): Promise<DiagramSpec> {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'diagram-create',
    readFiles: true,
    effort: 'medium',
    maxTurns: 12,
    system: `${tutor('diagrams')}

Your job now: build ONE interactive diagram (an "explorable") that helps the learner see the idea. It is rendered live in a sandbox.
${DIAGRAM_CONTRACT}`,
    prompt: `${describeClass(env.ctx, { includeRecords: false })}

${anchorContext ? `What the learner is looking at:\n${anchorContext}\n\n` : ''}Request: ${request}

Build the diagram now.`,
    schema: DiagramSchema,
    demo: () => demo.diagram(request)
  })
}

export function repairDiagram(env: JobEnv, spec: DiagramSpec, error: string): Promise<DiagramSpec> {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'diagram-repair',
    readFiles: false,
    effort: 'medium',
    system: `You fix interactive diagram code for mint. Keep the same intent, elements and params unless they caused the error.\n${DIAGRAM_CONTRACT}`,
    prompt: `This diagram failed in the sandbox with:\n${error}\n\nCurrent spec:\n${JSON.stringify(spec)}\n\nReturn the corrected full spec.`,
    schema: DiagramSchema,
    demo: () => demo.diagram(spec.title)
  })
}

// ---------------------------------------------------------------------------
// Reference sheets and note review (authorship fades to the learner)
// ---------------------------------------------------------------------------

export function draftReference(env: JobEnv, topic: Topic | null) {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'reference-draft',
    readFiles: true,
    effort: 'medium',
    system: `${tutor('reference', 'glossary')}

Your job now: draft a one-page reference sheet (markdown): the compressed essence for quick review later, not a lesson. Use the learner's glossary terms, short definitions, key formulas or steps, one tiny worked example, and common pitfalls. Every key claim cites the materials with [[cite:...]]. At most ~350 words. The learner will edit it into their own words.`,
    prompt: `${describeClass(env.ctx)}\n\n${topic ? describeTopic(env.ctx, topic) : 'Cover the class so far (mastered and in-progress topics).'}\n\nDraft it now.`,
    schema: ReferenceDraftSchema,
    demo: () => demo.reference(env.ctx, topic)
  })
}

export function reviewNote(env: JobEnv, note: NoteDoc, onDelta: (d: string) => void): Promise<string> {
  return runText(env.runtime, {
    ...base(env),
    purpose: 'note-review',
    readFiles: true,
    effort: 'low',
    onDelta,
    system: `${tutor('reference')}

Your job now: review the learner's own note or reference sheet. Do not rewrite it. In at most 150 words: what is accurate, anything wrong or imprecise (cite where to check), and one thing worth adding. They will make the edits.`,
    prompt: `${describeClass(env.ctx, { includeRecords: false })}\n\nTheir ${note.kind} "${note.title}":\n\n${note.body}`,
    demo: () => demo.noteReview(note)
  })
}
