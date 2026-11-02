import type { Curriculum, Milestone, SourceMeta, SourceRef, Topic } from '@shared/types'
import { slugify } from '../store/fsutil'

/** Raw curriculum shape as produced by the model (already schema-validated). */
export interface RawCurriculum {
  summary: string
  project: { title: string; deliverable: string } | null
  assumptions: string[]
  cadence: string
  milestones: {
    title: string
    deliverable: string
    topics: {
      id?: string
      title: string
      objective: string
      prerequisites: string[]
      sources: { sourceId: string; section: string; note?: string }[]
      practice: string
      gate: string
    }[]
  }[]
}

export interface SourceIndex {
  meta: SourceMeta
  sectionLabels: string[]
}

/**
 * Turn a model-proposed plan into a valid curriculum. Code, not the model,
 * guarantees the invariants the rest of the app relies on:
 *  - unique, stable topic ids
 *  - prerequisites refer to existing topics and form a DAG
 *  - source references point at real sources and sections
 * Every repair is reported so the learner sees what changed.
 */
export function validateCurriculum(raw: RawCurriculum, sources: SourceIndex[], previous: Curriculum | null): { curriculum: Curriculum; repairs: string[] } {
  const repairs: string[] = []
  const usedIds = new Set<string>()
  // Map from any identifier the model used (id or title slug) to the final id.
  const alias = new Map<string, string>()
  const previousIdsByTitle = new Map<string, string>()
  for (const m of previous?.milestones ?? []) for (const t of m.topics) previousIdsByTitle.set(t.title.trim().toLowerCase(), t.id)

  const milestones: Milestone[] = []
  raw.milestones.forEach((rm, mi) => {
    const topics: Topic[] = []
    for (const rt of rm.topics) {
      const title = rt.title.trim() || 'Untitled topic'
      // Keep ids stable across curriculum revisions so progress carries over.
      let id = previousIdsByTitle.get(title.toLowerCase()) ?? slugify(rt.id || title, 40)
      if (usedIds.has(id)) {
        let n = 2
        while (usedIds.has(`${id}-${n}`)) n++
        id = `${id}-${n}`
      }
      usedIds.add(id)
      // First definition wins: a reused id or title must not hijack earlier references.
      const addAlias = (key: string) => {
        if (key && !alias.has(key)) alias.set(key, id)
      }
      if (rt.id) addAlias(rt.id.trim().toLowerCase())
      addAlias(title.toLowerCase())
      addAlias(slugify(title, 40))
      topics.push({
        id,
        title,
        objective: rt.objective.trim(),
        prerequisites: rt.prerequisites,
        sources: rt.sources.map((s) => ({ sourceId: s.sourceId, section: s.section, note: s.note })),
        practice: rt.practice.trim(),
        gate: rt.gate.trim()
      })
    }
    if (topics.length === 0) {
      repairs.push(`Dropped empty milestone "${rm.title}".`)
      return
    }
    milestones.push({ id: `m${mi + 1}-${slugify(rm.title, 24)}`, title: rm.title.trim(), deliverable: rm.deliverable.trim(), topics })
  })

  const allTopics = milestones.flatMap((m) => m.topics)
  const order = new Map(allTopics.map((t, i) => [t.id, i]))

  // Resolve prerequisites; drop unknown ones and anything that is not earlier in the plan.
  for (const topic of allTopics) {
    const resolved: string[] = []
    for (const p of topic.prerequisites) {
      const key = p.trim().toLowerCase()
      const target = alias.get(key) ?? alias.get(slugify(p, 40))
      if (!target) {
        repairs.push(`"${topic.title}": removed unknown prerequisite "${p}".`)
        continue
      }
      if (target === topic.id) continue
      if ((order.get(target) ?? 0) > (order.get(topic.id) ?? 0)) {
        repairs.push(`"${topic.title}": removed prerequisite "${allTopics[order.get(target)!].title}" because it comes later (it would create a loop).`)
        continue
      }
      if (!resolved.includes(target)) resolved.push(target)
    }
    topic.prerequisites = resolved
  }

  // Validate source references.
  const byId = new Map(sources.map((s) => [s.meta.id, s]))
  for (const topic of allTopics) {
    const valid: SourceRef[] = []
    for (const ref of topic.sources) {
      const src = byId.get(ref.sourceId)
      if (!src) {
        repairs.push(`"${topic.title}": removed a reference to a source that does not exist.`)
        continue
      }
      const section = matchSection(ref.section, src.sectionLabels)
      if (!section) {
        repairs.push(`"${topic.title}": section "${ref.section}" not found in "${src.meta.title}"; pointed to the start instead.`)
      }
      valid.push({ sourceId: ref.sourceId, section: section ?? src.sectionLabels[0] ?? '', note: ref.note })
    }
    topic.sources = valid
  }

  return {
    curriculum: {
      version: (previous?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      summary: raw.summary.trim(),
      project: raw.project && raw.project.title.trim() ? { title: raw.project.title.trim(), deliverable: raw.project.deliverable.trim() } : null,
      assumptions: raw.assumptions.map((a) => a.trim()).filter(Boolean),
      cadence: raw.cadence.trim(),
      milestones
    },
    repairs
  }
}

/** Find the section label a reference means, tolerating "p.12" vs "p. 12" and case. */
export function matchSection(wanted: string, labels: string[]): string | null {
  if (!wanted) return null
  const norm = (s: string) => s.toLowerCase().replace(/^(page|pp?\.?)\s*/, 'p ').replace(/[^a-z0-9:]+/g, ' ').trim()
  const w = norm(wanted)
  const exact = labels.find((l) => norm(l) === w)
  if (exact) return exact
  const partial = labels.find((l) => norm(l).includes(w) || w.includes(norm(l)))
  return partial ?? null
}

export { allTopics, findTopic, diffCurricula } from '@shared/curriculum'
