import { join } from 'node:path'
import type { ClassMeta, Contents, Curriculum, GlossaryTerm, IndependenceState, LearningRecord, QuickCourse, SourceMeta, Topic, TopicProgress } from '@shared/types'
import { allTopics } from '@shared/curriculum'
import { classMode, readingTime } from '@shared/mode'

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
  /** Simple mode: the list of what the materials contain. */
  contents: Contents | null
  /** Quick mode: the course mint wrote. */
  quickCourse: QuickCourse | null
  progress: Record<string, TopicProgress>
  records: LearningRecord[]
  glossary: GlossaryTerm[]
  independence: IndependenceState
}

/** The file the tutor reads the quick course from (written with the class's other exports). */
export const QUICK_COURSE_FILE = 'COURSE.md'

/**
 * What a job must know about a class that is not a course. It goes into the
 * class description, so every job (the chat, quizzes, exercises, diagrams)
 * reads it.
 */
function modeNote(ctx: ClassContext): string {
  const mode = classMode(ctx.meta)
  if (mode === 'simple') {
    return 'Mode: Simple. The learner opened this material to learn from it quickly. This class has no plan, no lessons and no checks: never mention them or suggest one. Explain what they ask about, from the material.'
  }
  if (mode === 'quick') {
    const noSources = ctx.sources.length
      ? ''
      : ' This class has no source materials: teach from your own knowledge, never remark that materials are missing or that something is "outside your materials", and never write a [[cite:...]] directive.'
    return `Mode: Quick course. The learner described what they want to learn and mint wrote them a short course to read (under "The written course"). This class has no plan, no lessons and no checks: never mention them or suggest one.${noSources} Before answering about the course, read its file, and keep to its terms and examples.`
  }
  return ''
}

export function describeClass(ctx: ClassContext, opts: { includeCurriculum?: boolean; includeRecords?: boolean } = {}): string {
  const m = ctx.meta.mission
  const lines: string[] = [
    `# Class: ${ctx.meta.title}`,
    modeNote(ctx),
    `Mission: ${m.why || '(not stated)'}`,
    m.successLooksLike.length ? `Success looks like: ${m.successLooksLike.join('; ')}` : '',
    m.constraints.length ? `Constraints: ${m.constraints.join('; ')}` : '',
    m.outOfScope.length ? `Out of scope: ${m.outOfScope.join('; ')}` : '',
    `Time available: ${ctx.meta.intake.timePerWeek || 'unspecified'}; sessions: ${ctx.meta.intake.sessionLength || 'unspecified'}; timeline: ${ctx.meta.intake.timeline || 'unspecified'}`,
    ctx.meta.intake.priorExperience ? `Prior experience (self-reported): ${ctx.meta.intake.priorExperience}` : '',
    ctx.meta.intake.preferences ? `Preferences: ${ctx.meta.intake.preferences}` : '',
    '',
    '## Sources',
    ctx.sources.length ? '' : '(none)',
    ...ctx.sources.map(
      (s) =>
        `- ${s.meta.id}: "${s.meta.title}" (${s.meta.kind}, ${s.meta.origin === 'user' ? "learner's own" : 'trusted public source'})\n  file: ${join(ctx.dir, 'sources', s.meta.id, 'content.md')}\n  sections: ${summarizeLabels(s.sectionLabels)}`
    ),
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
  if (classMode(ctx.meta) === 'simple' && ctx.contents?.items.length) {
    lines.push('## Contents (what mint listed in the materials; the learner picks an item to have it explained)')
    for (const item of ctx.contents.items) lines.push(`- ${item.title}: ${item.summary}`)
    lines.push('')
  }
  const course = ctx.quickCourse
  if (course) {
    lines.push(
      `## The written course: "${course.title}" (${readingTime(course.minutes)} to read)`,
      `file: ${join(ctx.dir, QUICK_COURSE_FILE)}`,
      `The learner asked for: ${course.request}`,
      ...course.sections.map((s, i) => `${i + 1}. ${s.title}${s.body === undefined ? ' (not written yet)' : ''}`),
      ''
    )
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
