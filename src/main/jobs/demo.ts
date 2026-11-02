import type { Brief, CheckKind, Diagnostic, NoteDoc, Session, Topic, Verdict } from '@shared/types'
import type { ClassContext } from './context'
import type { ThreadContext } from './index'
import type { CurriculumOutput, DiagramOutput } from './schemas'
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
    questions: [`What is the main idea of "${topic.title}"?`, 'What reason or evidence does the text give for it?']
  }
}

export function checkPrompt(topic: Topic, kind: CheckKind): string {
  if (kind === 'explain') return `Explain "${topic.title}" in your own words, as if to a friend who has not read it.`
  if (kind === 'apply') return `Here is a new situation: think of a concrete example from your own life or work where "${topic.title}" applies. Walk through how it applies, step by step.`
  return `"${topic.title}" is easy to confuse with nearby ideas. Name one, and explain how they differ and when each applies.`
}

export function verdict(answer: string, kind: CheckKind): Verdict {
  const n = words(answer)
  const unsure = /i don'?t know|no idea|not sure/i.test(answer)
  if (unsure || n < 8) {
    return { result: 'fail', feedback: 'That is not enough to judge yet, which is useful to know. Re-read the planned section and try again in your own words.', misconceptions: [] }
  }
  if (n < 25) {
    return {
      result: 'partial',
      feedback: `Good start for the ${kind} check. Add the reason behind it, and one concrete detail from the reading.`,
      misconceptions: []
    }
  }
  return { result: 'pass', feedback: 'Clear and in your own words. You covered the core idea with a reason. Nice work.', misconceptions: [] }
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
  stroke(40, 120, 90); strokeWeight(4); line(cx, cy, x, y);
  stroke(180, 120, 40); strokeWeight(3); line(cx, cy, x, cy);
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
