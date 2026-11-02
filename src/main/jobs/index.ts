import type {
  Anchor,
  Brief,
  CheckKind,
  Diagnostic,
  DiagramSpec,
  Explorable,
  GlossaryProposal,
  NoteDoc,
  RecordProposal,
  Rung,
  Session,
  SourceDoc,
  Thread,
  Topic,
  Verdict
} from '@shared/types'
import type { AgentRuntime } from '../agents/types'
import { describeClass, describeTopic, sectionText, TUTOR_PRINCIPLES, type ClassContext } from './context'
import { runStructured, runText } from './run'
import {
  BriefSchema,
  CheckPromptSchema,
  CurriculumSchema,
  DiagnosticQuestionsSchema,
  DiagnosticResultSchema,
  DiagramSchema,
  GlossaryCheckSchema,
  ReferenceDraftSchema,
  SourceProposalsSchema,
  VerdictSchema,
  WrapSchema,
  type CurriculumOutput
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
    system: `${TUTOR_PRINCIPLES}

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
    system: `${TUTOR_PRINCIPLES}

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
    system: `${TUTOR_PRINCIPLES}

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
    system: `${TUTOR_PRINCIPLES}

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
    system: `${TUTOR_PRINCIPLES}

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

export async function checkPrompt(env: JobEnv, topic: Topic, brief: Brief | undefined, kind: CheckKind): Promise<string> {
  if (kind === 'explain' && brief?.questions.length) {
    // Explain-back uses the brief's own questions: the learner read with them in mind.
    return `Without looking back at the text, explain in your own words:\n\n${brief.questions.map((q) => `- ${q}`).join('\n')}`
  }
  const what =
    kind === 'explain'
      ? 'an explain-back prompt: ask the learner to explain the core idea in their own words, as if teaching a friend'
      : kind === 'apply'
        ? 'an application task: a NEW concrete case (numbers, a scenario, a small problem, or the next step of their project) that requires using the idea, not restating it. Not a case from the reading.'
        : 'a distinguish prompt: ask how this idea differs from one or two nearby ideas it is easily confused with (name them), and when each applies'
  const out = await runStructured(env.runtime, {
    ...base(env),
    purpose: `check-prompt-${kind}`,
    readFiles: true,
    effort: 'low',
    system: `${TUTOR_PRINCIPLES}\n\nYour job now: write ${what}. Keep it to 1 to 4 sentences. Answerable in a short paragraph. Do not include the answer or hints.`,
    prompt: `${describeClass(env.ctx)}\n\n${describeTopic(env.ctx, topic)}\n\nWrite the prompt now.`,
    schema: CheckPromptSchema,
    demo: () => ({ prompt: demo.checkPrompt(topic, kind) })
  })
  return out.prompt.trim()
}

export function judgeCheck(env: JobEnv, topic: Topic, kind: CheckKind, prompt: string, answer: string, rubricHint: string): Promise<Verdict> {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: `judge-${kind}`,
    readFiles: true,
    effort: 'medium',
    system: `${TUTOR_PRINCIPLES}

Your job now: judge one ${kind === 'explain' ? 'explain-back' : kind === 'apply' ? 'application' : 'distinguish'} answer against the learner's materials.
- "pass": accurate and in their own words, covering the core idea; small slips are fine.
- "partial": on the right track but missing a key step or with an imprecision that matters.
- "fail": wrong, missing the core idea, or just restating the question. "I don't know" is fail (that is fine and useful).
- feedback (markdown, at most 120 words): name what was right, then the single most important gap or misconception, and send them to the exact passage to fix it with a [[cite:...]] directive. Do not give a full model answer; the learner should do the repair.
- misconceptions: short phrases for any wrong beliefs you can see (empty if none).
Be honest; never pass an answer just to be encouraging.`,
    prompt: `${describeClass(env.ctx, { includeRecords: false })}

${describeTopic(env.ctx, topic)}
${rubricHint ? `\nWhat the learner read: ${rubricHint}` : ''}

Prompt given to the learner:
${prompt}

Learner's answer:
${answer.trim() || '(empty)'}

Check the relevant passages, then judge.`,
    schema: VerdictSchema,
    demo: () => demo.verdict(answer, kind)
  })
}

export function wrapSession(env: JobEnv, topic: Topic, session: Session) {
  const transcript = session.attempts
    .map((a) => `[${a.kind}] Prompt: ${a.prompt}\nAnswer: ${a.answer}\nVerdict: ${a.verdict?.result ?? 'n/a'}${a.verdict?.misconceptions.length ? ` (misconceptions: ${a.verdict.misconceptions.join('; ')})` : ''}`)
    .join('\n\n')
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'session-wrap',
    readFiles: false,
    effort: 'low',
    system: `${TUTOR_PRINCIPLES}

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
  4: `HELP RUNG 4 (EXPLANATION). Explain clearly and fully, grounded in their materials with [[cite:...]] citations, using one concrete example. Use as much detail as the question needs (no padding). End with one line pointing to the passage to re-read and one quick check question.`
}

export interface ThreadContext {
  thread: Thread
  rung: Rung
  voice: boolean
  /** Text around the anchor (for source anchors) or the quoted message. */
  anchorContext: string
  explorable?: Explorable
  sessionTopic?: Topic
}

export function tutorReply(env: JobEnv, t: ThreadContext, onDelta: (d: string) => void): Promise<string> {
  const { thread, rung, voice } = t
  const anchor = describeAnchor(thread.anchor, t)
  const history = thread.messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'Learner' : 'Tutor'}${m.rung ? ` (rung ${m.rung})` : ''}: ${m.text}`)
    .join('\n\n')
  const diagramRules = t.explorable
    ? `\nThe learner is looking at the interactive diagram "${t.explorable.spec.title}". Its parts: ${t.explorable.spec.elements.map((e) => `${e.id} (${e.label})`).join(', ')}. Its sliders: ${t.explorable.spec.params.map((p) => `${p.id} (${p.label}, ${p.min} to ${p.max}, now ${p.value})`).join(', ') || 'none'}.
Point at parts while you talk: put [[highlight:<elementId>]] right where you mention a part, and [[set:<paramId>=<value>]] where moving a slider helps. Use only the ids above.`
    : ''
  const voiceRules = voice
    ? `\nYour reply will be SPOKEN aloud by a voice tutor. Write for the ear: short sentences, no tables, no code blocks, no bullet lists, no headings; say math in words where you can. Explain in small chunks and include one quick check-in question. Keep citations as directives (they are shown on screen, not read).`
    : ''
  return runText(env.runtime, {
    ...base(env),
    purpose: `tutor-rung-${rung}`,
    readFiles: true,
    effort: rung === 4 ? 'medium' : 'low',
    onDelta,
    system: `${TUTOR_PRINCIPLES}

You are answering in a small Ask popover next to what the learner is reading. ${RUNG_RULES[rung]}
If the materials do not cover the question, say so plainly in one sentence, then help using general knowledge clearly labeled "outside your materials".${diagramRules}${voiceRules}`,
    prompt: `${describeClass(env.ctx)}
${t.sessionTopic ? `\nCurrent study topic: ${t.sessionTopic.title} (${t.sessionTopic.objective})` : ''}

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
// Glossary: the learner defines; the tutor checks against the sources
// ---------------------------------------------------------------------------

export function checkGlossaryTerm(env: JobEnv, term: string, definition: string, context: string) {
  return runStructured(env.runtime, {
    ...base(env),
    purpose: 'glossary-check',
    readFiles: true,
    effort: 'low',
    system: `${TUTOR_PRINCIPLES}

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
    system: `${TUTOR_PRINCIPLES}

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
    system: `${TUTOR_PRINCIPLES}

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
    system: `${TUTOR_PRINCIPLES}

Your job now: review the learner's own note or reference sheet. Do not rewrite it. In at most 150 words: what is accurate, anything wrong or imprecise (cite where to check), and one thing worth adding. They will make the edits.`,
    prompt: `${describeClass(env.ctx, { includeRecords: false })}\n\nTheir ${note.kind} "${note.title}":\n\n${note.body}`,
    demo: () => demo.noteReview(note)
  })
}

export type { RecordProposal, GlossaryProposal, SourceDoc }
export { sectionText }
