import type { LearningRecord, RecordProposal } from '@shared/types'
import { newId, nowIso, slugify } from '../store/fsutil'
import type { Kernel } from './kernel'

/** Append learning records with /teach numbering (call under the class lock). */
export async function appendRecords(k: Kernel, classId: string, proposals: RecordProposal[], extra: { sessionId?: string; topicId?: string } = {}): Promise<LearningRecord[]> {
  if (!proposals.length) return []
  const created: LearningRecord[] = []
  await k.repo.update(classId, 'records', (list) => {
    let number = list.reduce((max, r) => Math.max(max, r.number), 0)
    for (const p of proposals) {
      const title = p.title.trim().slice(0, 160)
      if (!title) continue
      number += 1
      created.push({
        id: newId('lr'),
        number,
        slug: slugify(title),
        title,
        body: p.body.trim().slice(0, 1200),
        evidence: p.evidence.trim().slice(0, 1200),
        kind: p.kind,
        topicId: p.topicId ?? extra.topicId,
        sessionId: extra.sessionId,
        createdAt: nowIso()
      })
    }
    return [...list, ...created]
  })
  return created
}
