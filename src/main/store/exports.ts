import type { ClassMeta, Curriculum, GlossaryTerm, LearningRecord, NoteDoc, SourceMeta, SourceProposal } from '@shared/types'
import { slugify } from './fsutil'

/**
 * Human-readable exports that keep each class folder a valid /teach-style
 * workspace. They are regenerated from state; state stays the source of truth.
 */

export function missionMd(meta: ClassMeta): string {
  const m = meta.mission
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none yet)')
  return `# Mission: ${m.topic || meta.title}

## Why
${m.why || '(not stated yet)'}

## Success looks like
${list(m.successLooksLike)}

## Constraints
${list([...m.constraints, meta.intake.timePerWeek && `Time: ${meta.intake.timePerWeek}`, meta.intake.timeline && `Timeline: ${meta.intake.timeline}`].filter(Boolean) as string[])}

## Out of scope
${list(m.outOfScope)}
`
}

export function curriculumMd(c: Curriculum, sources: SourceMeta[]): string {
  const title = (id: string) => sources.find((s) => s.id === id)?.title ?? id
  const lines = [`# Curriculum (v${c.version})`, '', c.summary, '']
  if (c.project) lines.push(`**Project:** ${c.project.title}: ${c.project.deliverable}`, '')
  if (c.cadence) lines.push(`**Cadence:** ${c.cadence}`, '')
  if (c.assumptions.length) lines.push('## Assumptions', ...c.assumptions.map((a) => `- ${a}`), '')
  c.milestones.forEach((m, i) => {
    lines.push(`## Milestone ${i + 1}: ${m.title}`, `Deliverable: ${m.deliverable}`, '')
    for (const t of m.topics) {
      lines.push(`### ${t.title}`, t.objective)
      if (t.prerequisites.length) lines.push(`- Prerequisites: ${t.prerequisites.join(', ')}`)
      if (t.sources.length) lines.push(`- Read: ${t.sources.map((s) => `${title(s.sourceId)} (${s.section})`).join('; ')}`)
      if (t.practice) lines.push(`- Practice: ${t.practice}`)
      if (t.gate) lines.push(`- Gate: ${t.gate}`)
      lines.push('')
    }
  })
  return lines.join('\n')
}

export function resourcesMd(meta: ClassMeta, sources: SourceMeta[], proposals: SourceProposal[]): string {
  const entry = (s: SourceMeta) =>
    `- ${s.url ? `[${s.title}](${s.url})` : s.title} (${s.kind}, ${s.origin === 'user' ? 'yours' : 'found by mint'})${s.why ? `\n  ${s.why}` : ''}`
  const rejected = proposals.filter((p) => p.status === 'rejected')
  return `# ${meta.title} Resources

## Knowledge
${sources.length ? sources.map(entry).join('\n') : '- (no sources yet)'}

## Trusted domains
${meta.trustedDomains.map((d) => `- ${d}`).join('\n')}
${rejected.length ? `\n## Rejected suggestions\n${rejected.map((p) => `- ${p.title} (${p.domain})`).join('\n')}\n` : ''}`
}

export function glossaryMd(meta: ClassMeta, terms: GlossaryTerm[]): string {
  const body = [...terms]
    .sort((a, b) => a.term.localeCompare(b.term))
    .map((t) => `**${t.term}**:\n${t.definition}${t.avoid.length ? `\n_Avoid_: ${t.avoid.join(', ')}` : ''}`)
    .join('\n\n')
  return `# ${meta.title} Glossary\n\nTerms you have shown you understand, in your own words.\n\n## Terms\n\n${body || '(none yet)'}\n`
}

export function recordFileName(r: LearningRecord): string {
  return `learning-records/${String(r.number).padStart(4, '0')}-${r.slug}.md`
}

export function recordMd(r: LearningRecord, all: LearningRecord[]): string {
  const sup = r.supersededBy ? all.find((x) => x.id === r.supersededBy) : undefined
  const status = sup ? `---\nstatus: superseded by LR-${String(sup.number).padStart(4, '0')}\n---\n\n` : ''
  return `${status}# ${r.title}\n\n${r.body}\n${r.evidence ? `\n## Evidence\n${r.evidence}\n` : ''}`
}

export function noteFileName(n: NoteDoc): string {
  return `${n.kind === 'reference' ? 'reference' : 'notes'}/${slugify(n.title)}-${n.id.slice(-6)}.md`
}

export function noteMd(n: NoteDoc): string {
  return `# ${n.title}\n\n${n.body}\n`
}
