import type { Curriculum, Topic } from './types'

export function allTopics(curriculum: Curriculum | null): Topic[] {
  return curriculum?.milestones.flatMap((m) => m.topics) ?? []
}

export function findTopic(curriculum: Curriculum | null, topicId: string): Topic | undefined {
  return allTopics(curriculum).find((t) => t.id === topicId)
}
