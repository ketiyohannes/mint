import type { ClassMeta, Curriculum, GlossaryTerm, IndependenceState, LearningRecord, SourceDoc, SourceMeta, Topic, TopicProgress } from '@shared/types'
import { allTopics } from '@shared/curriculum'

export interface SourceOutline {
  meta: SourceMeta
  sectionLabels: string[]
}

/** Everything a job may need to know about a class, assembled by code. */
export interface ClassContext {
  dir: string
  meta: ClassMeta
  sources: SourceOutline[]
  curriculum: Curriculum | null
  progress: Record<string, TopicProgress>
  records: LearningRecord[]
  glossary: GlossaryTerm[]
  independence: IndependenceState
}

/** The tutor's standing identity and pedagogy (adapted from the /teach skill). */
export const TUTOR_PRINCIPLES = `You are the tutor inside mint, a self-study harness. Its north star: the more the learner uses mint, the less they need it.

Principles you always follow:
- The learner's materials are the authority. They live in this folder as sources/<sourceId>/content.md (sections are "## [<label>]" headings; every block ends with "^<blockId>"). Read them with your file tools before making claims. Clearly label anything that comes from outside the materials as "outside your materials".
- Send the learner back to the source. Prefer pointing to the exact passage over paraphrasing it.
- Cite with directives: [[cite:<sourceId>|<section label exactly as in the "## [...]" heading>|<short exact quote, at most 12 words, copied verbatim from that section>]].
- Automate logistics, never the thinking: do not do work the learner can reasonably do themselves.
- Keep cognitive load low: short, concrete, one idea at a time. Use the learner's glossary terms when they exist.
- Desirable difficulty: retrieval, explanation in their own words, application to new cases. Fluency is not mastery.
- Math: use $...$ inline and $$...$$ for display.`

export function describeClass(ctx: ClassContext, opts: { includeCurriculum?: boolean; includeRecords?: boolean } = {}): string {
  const m = ctx.meta.mission
  const lines: string[] = [
    `# Class: ${ctx.meta.title}`,
    `Mission: ${m.why || '(not stated)'}`,
    m.successLooksLike.length ? `Success looks like: ${m.successLooksLike.join('; ')}` : '',
    m.constraints.length ? `Constraints: ${m.constraints.join('; ')}` : '',
    m.outOfScope.length ? `Out of scope: ${m.outOfScope.join('; ')}` : '',
    `Time available: ${ctx.meta.intake.timePerWeek || 'unspecified'}; sessions: ${ctx.meta.intake.sessionLength || 'unspecified'}; timeline: ${ctx.meta.intake.timeline || 'unspecified'}`,
    ctx.meta.intake.priorExperience ? `Prior experience (self-reported): ${ctx.meta.intake.priorExperience}` : '',
    ctx.meta.intake.preferences ? `Preferences: ${ctx.meta.intake.preferences}` : '',
    '',
    '## Sources (read them at sources/<sourceId>/content.md)',
    ...ctx.sources.map((s) => `- ${s.meta.id}: "${s.meta.title}" (${s.meta.kind}, ${s.meta.origin === 'user' ? "learner's own" : 'trusted public source'}). Sections: ${summarizeLabels(s.sectionLabels)}`),
    ''
  ]
  if (opts.includeCurriculum && ctx.curriculum) {
    lines.push('## Curriculum')
    for (const ms of ctx.curriculum.milestones) {
      lines.push(`- Milestone: ${ms.title}`)
      for (const t of ms.topics) lines.push(`  - [${ctx.progress[t.id]?.status ?? 'locked'}] ${t.id}: ${t.title}`)
    }
    lines.push('')
  }
  if (opts.includeRecords !== false && ctx.records.length) {
    lines.push('## Learning records (evidence of what the learner knows; newest last)')
    for (const r of ctx.records.filter((r) => !r.supersededBy).slice(-15)) lines.push(`- (${r.kind}) ${r.title}: ${r.body}`)
    lines.push('')
  }
  if (ctx.glossary.length) {
    lines.push(`## Learner's glossary (use these terms): ${ctx.glossary.map((g) => g.term).join(', ')}`, '')
  }
  lines.push(`Independence level: ${ctx.independence.level} of 3 (higher = needs less help).`)
  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n')
}

function summarizeLabels(labels: string[]): string {
  if (labels.length <= 14) return labels.join(' | ')
  return `${labels.slice(0, 6).join(' | ')} | … | ${labels.slice(-4).join(' | ')} (${labels.length} sections)`
}

export function describeTopic(ctx: ClassContext, topic: Topic): string {
  const title = (id: string) => ctx.sources.find((s) => s.meta.id === id)?.meta.title ?? id
  const prereqs = topic.prerequisites.map((p) => allTopics(ctx.curriculum).find((t) => t.id === p)?.title ?? p)
  return [
    `Topic: ${topic.title} (id ${topic.id})`,
    `Objective: ${topic.objective}`,
    prereqs.length ? `Builds on: ${prereqs.join(', ')}` : '',
    topic.sources.length ? `Planned readings: ${topic.sources.map((s) => `${title(s.sourceId)} [${s.section}] (sourceId ${s.sourceId})`).join('; ')}` : '',
    topic.practice ? `Practice idea: ${topic.practice}` : '',
    topic.gate ? `Mastery gate: ${topic.gate}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** Text of one section, trimmed, for prompts and demo answers. */
export function sectionText(doc: SourceDoc, label: string, maxChars = 6000): string {
  const section = doc.sections.find((s) => s.label === label) ?? doc.sections[0]
  if (!section) return ''
  return section.blocks
    .map((b) => b.text)
    .join('\n')
    .slice(0, maxChars)
}
