import type { Brief, CheckAttempt, CheckKind, Diagnostic, NoteDoc, Session, Topic, Verdict } from '@shared/types'
import type { ClassContext } from './context'
import type { ThreadContext } from './index'
import type { CurriculumOutput, DiagramOutput, ExerciseOutput, IntakeQuestionsOutput, QuizOutput } from './schemas'
import type { CodeLanguage } from '@shared/types'
import { slugify } from '../store/fsutil'

/**
 * Deterministic answers for the offline Demo provider. They are computed from
 * the learner's real inputs so every screen behaves realistically, but they
 * are scripted, never presented as model output.
 */

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

export function sourceProposals(ctx: ClassContext) {
  const topic = ctx.meta.mission.topic || ctx.meta.title
  const slug = encodeURIComponent(topic.trim().replace(/\s+/g, '_'))
  return {
    proposals: [
      {
        title: `${topic} (Wikipedia)`,
        url: `https://en.wikipedia.org/wiki/${slug}`,
        kind: 'web' as const,
        why: 'Community-reviewed encyclopedia article with references to primary sources.',
        covers: 'Definitions, history and the core ideas at an introductory level.'
      },
      {
        title: `${topic} (Britannica)`,
        url: `https://www.britannica.com/search?query=${encodeURIComponent(topic)}`,
        kind: 'web' as const,
        why: 'Edited reference work written by subject experts.',
        covers: 'A second, independent overview to compare against.'
      }
    ]
  }
}

export function diagnosticQuestions(ctx: ClassContext) {
  const topic = ctx.meta.mission.topic || ctx.meta.title
  const firstSection = ctx.sources[0]?.sectionLabels.find((l) => !/^p\. ?1$/i.test(l)) ?? 'the first chapter'
  return {
    questions: [
      `What have you already studied or built that involves ${topic}? How confident are you with it?`,
      `In a sentence or two, what do you think ${topic} is about?`,
      `Without looking anything up: what do you expect "${firstSection}" to explain?`
    ]
  }
}

export function diagnosticResult(diag: Diagnostic) {
  const answered = diag.answers.filter((a) => words(a) >= 6 && !/i don'?t know|no idea|not sure/i.test(a))
  return {
    summary: answered.length
      ? `You gave substantive answers to ${answered.length} of ${diag.questions.length} questions, so the plan can skip a little of the basics.`
      : 'You are new to this, so the plan starts from the foundations.',
    startingLevel: answered.length ? 'some prior knowledge' : 'new to the topic',
    records: answered.slice(0, 2).map((a, i) => ({
      title: `Prior knowledge noted (diagnostic ${i + 1})`,
      body: 'The learner described this in their own words during intake, so early lessons can move faster here.',
      evidence: `"${a.slice(0, 200)}"`,
      kind: 'prior-knowledge' as const
    }))
  }
}

/** Page numbers and timestamps are locators, not topic names. */
const GENERIC_LABEL = /^(p\. ?\d+|\d{1,2}(:\d{2}){1,2})$/i

export function curriculum(ctx: ClassContext): CurriculumOutput {
  const topic = ctx.meta.mission.topic || ctx.meta.title
  // One topic per meaningful section, grouped into milestones of three.
  const picks: { sourceId: string; label: string }[] = []
  for (const s of ctx.sources) {
    const labels = s.sectionLabels.filter((l) => l && !/^(introduction|contents|references|bibliography)$/i.test(l))
    for (const l of (labels.length ? labels : s.sectionLabels).slice(0, 6)) picks.push({ sourceId: s.meta.id, label: l })
  }
  if (!picks.length) picks.push({ sourceId: ctx.sources[0]?.meta.id ?? 'none', label: ctx.sources[0]?.sectionLabels[0] ?? '' })
  const chosen = picks.slice(0, 6)
  const milestones: CurriculumOutput['milestones'] = []
  for (let i = 0; i < chosen.length; i += 3) {
    const group = chosen.slice(i, i + 3)
    milestones.push({
      title: i === 0 ? `Foundations of ${topic}` : `Going further with ${topic}`,
      deliverable: i === 0 ? 'Explain the core ideas in your own words to a friend.' : 'Apply the ideas to a small problem of your own.',
      topics: group.map((p, j) => {
        const title = GENERIC_LABEL.test(p.label) ? `${topic}: part ${i + j + 1}` : p.label
        const id = slugify(title, 40)
        const prev = i + j > 0 ? chosen[i + j - 1] : null
        const prevTitle = prev ? (GENERIC_LABEL.test(prev.label) ? `${topic}: part ${i + j}` : prev.label) : null
        return {
          id,
          title,
          objective: `Understand and use the ideas in "${p.label}".`,
          prerequisites: prevTitle ? [slugify(prevTitle, 40)] : [],
          sources: [{ sourceId: p.sourceId, section: p.label, note: 'Read the whole section once, then skim it again for the key claims.' }],
          practice: 'Explain it aloud in two minutes, then solve one small example.',
          gate: 'Explain it, apply it to a new case, and say how it differs from a nearby idea.'
        }
      })
    })
  }
  return {
    summary: `A ${milestones.length}-milestone path through ${topic}, built from your materials in reading order.`,
    project: { title: `Teach ${topic} back`, deliverable: 'A one-page explainer in your own words with one worked example.' },
    assumptions: ['Sections of your materials are in a sensible teaching order.', `About ${ctx.meta.intake.sessionLength || '30 minutes'} per session.`],
    cadence: ctx.meta.intake.timePerWeek ? `Sessions spread across ${ctx.meta.intake.timePerWeek}.` : 'Two or three short sessions per week.',
    milestones
  }
}

export function brief(ctx: ClassContext, topic: Topic): Brief {
  const reading = topic.sources[0]
  return {
    win: `You can explain "${topic.title}" in your own words and use it once.`,
    whyItMatters: `It moves you toward your mission: ${(ctx.meta.mission.why || ctx.meta.title).replace(/[.!?]+$/, '')}.`,
    readings: reading ? [{ sourceId: reading.sourceId, section: reading.section, note: 'Read for the main claim and the reason behind it.' }] : [],
    questions: [`What is the main idea of "${topic.title}"?`, 'What reason or evidence does the text give for it?', 'Where does a statement like $A\\mathbf{x} = \\lambda \\mathbf{x}$ appear, and what does each symbol stand for?']
  }
}

export function checkPrompt(topic: Topic, kind: CheckKind): string {
  if (kind === 'explain') return `Explain "${topic.title}" in your own words, as if to a friend who has not read it.`
  if (kind === 'apply') return `Here is a new situation: think of a concrete example from your own life or work where "${topic.title}" applies. Walk through how it applies, step by step.`
  return `"${topic.title}" is easy to confuse with nearby ideas. Name one, and explain how they differ and when each applies.`
}

/** Scripted judging. A retry counts what the earlier tries already said, as the real judge does. */
export function verdict(answer: string, kind: CheckKind, earlier: CheckAttempt[] = []): Verdict {
  const unsure = /i don'?t know|no idea|not sure/i.test(answer)
  const n = words(answer) + (unsure ? 0 : earlier.reduce((sum, a) => sum + words(a.answer), 0))
  const retry = earlier.length ? 'Building on your earlier try: ' : ''
  if (unsure || n < 8) {
    return { result: 'fail', feedback: `${retry}That is not enough to judge yet, which is useful to know. Re-read the planned section and try again in your own words.`, misconceptions: [] }
  }
  if (n < 25) {
    return {
      result: 'partial',
      feedback: `${retry}Good start for the ${kind} check. Add the reason behind it, and one concrete detail from the reading.`,
      misconceptions: []
    }
  }
  return { result: 'pass', feedback: `${retry}Clear and in your own words. You covered the core idea with a reason. Nice work.`, misconceptions: [] }
}

export function wrap(topic: Topic, session: Session) {
  const passed = session.attempts.filter((a) => a.verdict?.result === 'pass')
  return {
    summary: passed.length
      ? `You passed ${passed.length} of ${session.attempts.length} checks on "${topic.title}". Your explanations were in your own words.`
      : `You worked on "${topic.title}". Nothing passed yet, so the next session revisits it.`,
    records: passed.length
      ? [
          {
            title: `Can explain ${topic.title}`,
            body: `Demonstrated understanding of ${topic.title} by passing the ${passed.map((p) => p.kind).join(' and ')} check${passed.length > 1 ? 's' : ''}.`,
            evidence: `"${passed[0].answer.slice(0, 160)}"`,
            kind: 'understanding' as const
          }
        ]
      : [],
    terms: passed.length
      ? [{ term: topic.title, definition: passed[0].answer.split(/(?<=[.!?])\s/)[0].slice(0, 220), avoid: [], evidence: 'Used correctly in a passed check.' }]
      : []
  }
}

export function tutorReply(t: ThreadContext): string {
  return studyBoxNote(t) + ladderReply(t)
}

/** Show that the tutor sees the open lesson's study box (the step, and an unsent answer), from any chat. */
function studyBoxNote(t: ThreadContext): string {
  const s = t.session
  if (!s || s.endedAt) return ''
  const step = { brief: 'Brief', read: 'Read', explain: 'Explain', apply: 'Apply', distinguish: 'Distinguish', wrap: 'Wrap up' }[s.phase]
  const draft = t.studyDraft?.text.trim()
  const opening = draft ? draft.split(/\s+/).slice(0, 8).join(' ') : ''
  return `In your study box you are on the **${step}** step.${draft ? ` Your answer so far starts "${opening}"; keep going and tie it back to the reading.` : ''}\n\n`
}

function ladderReply(t: ThreadContext): string {
  const anchor = t.thread.anchor
  const cite =
    anchor.kind === 'source'
      ? `[[cite:${anchor.sourceId}|${anchor.sectionLabel}|${anchor.quote.split(/\s+/).slice(0, 6).join(' ')}]]`
      : ''
  const last = [...t.thread.messages].reverse().find((m) => m.role === 'user')?.text ?? ''
  if (anchor.kind === 'diagram' && t.explorable) {
    const el = anchor.elementId
    const param = t.explorable.spec.params[0]
    return `This part is ${anchor.label}. [[highlight:${el}]] Watch it as the value changes. ${param ? `[[set:${param.id}=${param.max}]]` : ''} What do you notice about how it responds? Try predicting before you move the slider yourself.`
  }
  switch (t.rung) {
    case 1:
      return `The answer is in the passage you highlighted ${cite}. Re-read the sentence right after it and look for the reason it gives.`
    case 2:
      return `Look again at ${cite}. What does the author say happens, and what causes it? Try answering that in one sentence.`
    case 3:
      return `Hint: focus on the cause-and-effect in ${cite}. The key is the relationship between the first idea and the second. Can you finish the thought?`
    default:
      return `Here is the full explanation. ${anchor.kind === 'source' ? `The passage ${cite} says: "${anchor.quote.slice(0, 140)}".` : ''} In plain terms, it is describing a relationship, and the example in the text shows it at work.\n\nYou asked: "${last.slice(0, 120)}". The short answer is that the text builds the idea step by step, so re-read it slowly with that in mind.\n\n**Check:** can you restate it in one sentence of your own?`
  }
}

export function glossaryCheck(term: string, definition: string) {
  const ok = words(definition) >= 6
  return {
    accepted: ok,
    feedback: ok ? 'That matches your materials. Added in your words.' : `Try a fuller definition of "${term}": say what it is, not just an example.`,
    definition: definition.trim(),
    avoid: []
  }
}

export function diagram(request: string): DiagramOutput {
  return {
    engine: 'p5',
    title: demoTitle(request),
    caption: 'Drag the slider and click any labeled part to ask about it.',
    params: [{ id: 'angle', label: 'Angle (degrees)', min: 0, max: 180, step: 1, value: 40 }],
    elements: [
      { id: 'vector', label: 'Vector', description: 'An arrow from the origin whose direction follows the angle.' },
      { id: 'projection', label: 'Projection', description: "The vector's shadow on the horizontal axis." },
      { id: 'origin', label: 'Origin', description: 'Where every arrow starts.' }
    ],
    code: `function setup() {
  createCanvas(mint.width, mint.height);
}
function draw() {
  background(250);
  const cx = width / 2, cy = height * 0.7, r = Math.min(width, height) * 0.35;
  const a = radians(mint.param('angle'));
  const x = cx + r * cos(a), y = cy - r * sin(a);
  stroke(200); line(20, cy, width - 20, cy);
  stroke(58, 95, 205); strokeWeight(4); line(cx, cy, x, y);
  stroke(124, 135, 152); strokeWeight(3); line(cx, cy, x, cy);
  noStroke(); fill(30); circle(cx, cy, 10);
  fill(60); textSize(13); text('vector', x + 6, y - 6); text('projection', (cx + x) / 2 - 24, cy + 18);
  mint.region('vector', { segment: [cx, cy, x, y], width: 8 });
  mint.region('projection', { segment: [cx, cy, x, cy], width: 8 });
  mint.region('origin', { circle: [cx, cy, 10] });
}`
  }
}

function demoTitle(request: string): string {
  const quoted = /"([^"]+)"/.exec(request)?.[1] ?? request
  const words = quoted.replace(/[^\p{L}\p{N}\s-]/gu, '').split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Explorable'
}

export function reference(ctx: ClassContext, topic: Topic | null) {
  const title = topic ? `${topic.title}: reference` : `${ctx.meta.title}: reference`
  const terms = ctx.glossary.map((g) => `- **${g.term}**: ${g.definition}`).join('\n')
  return {
    title,
    body: `## Key ideas\n- ${topic?.objective ?? 'The core ideas of this class.'}\n\n## Terms\n${terms || '- (add terms as you master them)'}\n\n## Pitfalls\n- Confusing the idea with a nearby one: say how they differ.\n\n_Draft by the tutor. Rewrite it in your own words._`
  }
}

export function noteReview(note: NoteDoc): string {
  const n = words(note.body)
  return n < 20
    ? 'This is a good start, but it is short. Add the reason behind the main idea and one example, in your own words.'
    : 'This reads accurately and is in your own words. One thing worth adding: a short example that shows the idea at work, and where in your materials it comes from.'
}

export function intakeQuestions(ctx: ClassContext, firstMessage: string): IntakeQuestionsOutput {
  const subject = ctx.sources[0]?.meta.title ?? (firstMessage.replace(/^(i want to |teach me |help me )?(learn|understand|study)?\s*/i, '').split(/[.?!]/)[0].trim() || 'your topic')
  const derived = subject.split(/\s+/).slice(0, 5).join(' ')
  const title = ctx.meta.title !== 'New class' ? ctx.meta.title : derived.charAt(0).toUpperCase() + derived.slice(1)
  return {
    title,
    intro: `Got it. ${ctx.sources.length ? `I can see ${ctx.sources.length} source${ctx.sources.length > 1 ? 's' : ''} in this class, starting with "${ctx.sources[0].meta.title}".` : 'You have not added materials yet, so I will find trusted ones.'} A few quick questions so the plan fits you:`,
    questions: [
      {
        header: 'Goal',
        question: 'What do you want to be able to do when you are done?',
        multiSelect: false,
        options: [
          { label: 'Understand it deeply', description: 'Explain the ideas and why they are true.' },
          { label: 'Use it in a project', description: 'Apply it to real work, with practice.' },
          { label: 'Pass an exam', description: 'Cover the syllabus and drill problems.' },
          { label: 'Get the big picture', description: 'A quick, solid overview.' }
        ]
      },
      {
        header: 'Background',
        question: 'How much do you already know about this?',
        multiSelect: false,
        options: [
          { label: 'New to it', description: 'Start from the foundations.' },
          { label: 'Some basics', description: 'I have seen the core ideas before.' },
          { label: 'Comfortable', description: 'Skip the basics, go deeper.' }
        ]
      },
      {
        header: 'Style',
        question: 'How do you like to practice?',
        multiSelect: true,
        options: [
          { label: 'Diagrams', description: 'Visual intuition first.' },
          { label: 'Quizzes', description: 'Quick retrieval practice.' },
          { label: 'Code exercises', description: 'Small programs that use the idea.' },
          { label: 'Worked examples', description: 'Step-by-step solutions.' }
        ]
      }
    ]
  }
}

export function quiz(ctx: ClassContext, focus: string): QuizOutput {
  const src = ctx.sources[0]
  const cite = src ? ` [[cite:${src.meta.id}|${src.sectionLabels[0] ?? ''}|]]` : ''
  return {
    title: `Quick check: ${focus.slice(0, 60)}`,
    questions: [
      {
        prompt: 'What happens to an eigenvector when the matrix multiplies it?',
        options: ['It rotates by 90 degrees', 'It stays on its line and is only scaled', 'It becomes the zero vector', 'It always doubles in length'],
        answer: 1,
        explanation: `By definition $A x = \\lambda x$: the direction is kept and only the length changes.${cite}`
      },
      {
        prompt: 'An eigenvalue of $-1$ means the eigenvector…',
        options: ['vanishes', 'is unchanged', 'flips to point the other way', 'rotates slightly'],
        answer: 2,
        explanation: `A negative eigenvalue reverses the direction along the same line.${cite}`
      },
      {
        prompt: 'Which equation finds the eigenvalues?',
        options: ['$\\det(A - \\lambda I) = 0$', '$A + \\lambda I = 0$', '$A x = 0$', '$\\lambda = \\det A$'],
        answer: 0,
        explanation: `The characteristic equation: $A - \\lambda I$ must squash some direction to zero.${cite}`
      }
    ]
  }
}

export function exercise(focus: string, language: CodeLanguage | null): ExerciseOutput {
  if (language === 'python') {
    return {
      title: 'Scale a vector',
      prompt: `Write \`scale(v, k)\` that returns a new list with every entry of \`v\` multiplied by \`k\` (this is what a matrix does to an eigenvector). Focus: ${focus}.\n\nExample: \`scale([1, 2], 3)\` returns \`[3, 6]\`.`,
      language: 'python',
      starter: 'def scale(v, k):\n    # return a new list\n    pass\n',
      tests: 'def test_basic():\n    assert scale([1, 2], 3) == [3, 6], "scale([1, 2], 3) should be [3, 6]"\n\ndef test_negative():\n    assert scale([1, -2], -1) == [-1, 2], "a negative k flips the vector"\n\ndef test_new_list():\n    v = [1, 2]\n    scale(v, 2)\n    assert v == [1, 2], "do not modify the input"\n',
      hint: 'Build a new list with one multiplication per entry.'
    }
  }
  return {
    title: 'Scale a vector',
    prompt: `Write \`scale(v, k)\` that returns a new array with every entry of \`v\` multiplied by \`k\` (this is what a matrix does to an eigenvector). Focus: ${focus}.\n\nExample: \`scale([1, 2], 3)\` returns \`[3, 6]\`.`,
    language: 'javascript',
    starter: 'function scale(v, k) {\n  // return a new array\n  return null\n}\n',
    tests: "test('scales every entry', () => assertEqual(scale([1, 2], 3), [3, 6]))\ntest('negative k flips the vector', () => assertEqual(scale([1, -2], -1), [-1, 2]))\ntest('does not modify the input', () => { const v = [1, 2]; scale(v, 2); assertEqual(v, [1, 2]) })\n",
    hint: 'Use map to build a new array.'
  }
}

export function codeReview(passed: number, total: number): string {
  return passed === total && total > 0
    ? `All ${total} tests pass. Your function keeps the input untouched and scales each entry, which is exactly what $A x = \\lambda x$ does along an eigenvector. **Next:** what should \`scale(v, 0)\` return, and what does that mean geometrically?`
    : `${passed} of ${total} tests pass. Look at the first failing test: what does it expect, and what does your function return for that input? Re-read the definition of scaling and try again.`
}
