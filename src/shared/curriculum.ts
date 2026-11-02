import type { Curriculum, Topic } from './types'

export function allTopics(curriculum: Curriculum | null): Topic[] {
  return curriculum?.milestones.flatMap((m) => m.topics) ?? []
}

export function findTopic(curriculum: Curriculum | null, topicId: string): Topic | undefined {
  return allTopics(curriculum).find((t) => t.id === topicId)
}

/** A compact, human-readable diff between two curricula for the approval UI. */
export function diffCurricula(prev: Curriculum | null, next: Curriculum): { added: string[]; removed: string[]; moved: string[] } {
  const before = allTopics(prev).map((t) => t.title)
  const after = allTopics(next).map((t) => t.title)
  const added = after.filter((t) => !before.includes(t))
  const removed = before.filter((t) => !after.includes(t))
  const common = after.filter((t) => before.includes(t))
  const beforeCommon = before.filter((t) => after.includes(t))
  const moved = common.filter((t, i) => beforeCommon[i] !== t)
  return { added, removed, moved }
}
