import type { ClassBundle, ClassMeta, ClassSummary, Intake, Mission } from '@shared/types'
import { allTopics } from '@shared/curriculum'
import { newId, nowIso } from '../store/fsutil'
import { normalizeDomain } from '../store/settingsStore'
import type { Kernel } from './kernel'
import { userError } from './kernel'

const clean = (s: string, max = 2000) =>
  String(s ?? '')
    .trim()
    .slice(0, max)
const cleanList = (items: string[]) =>
  Array.isArray(items)
    ? items
        .map((i) => clean(i, 400))
        .filter(Boolean)
        .slice(0, 20)
    : []

export function sanitizeMission(m: Mission): Mission {
  return {
    topic: clean(m?.topic, 200),
    why: clean(m?.why),
    successLooksLike: cleanList(m?.successLooksLike),
    constraints: cleanList(m?.constraints),
    outOfScope: cleanList(m?.outOfScope)
  }
}

export function sanitizeIntake(i: Intake): Intake {
  const mode = (['own', 'trusted', 'mixed'] as const).includes(i?.materialsMode) ? i.materialsMode : 'own'
  return {
    timeline: clean(i?.timeline, 200),
    timePerWeek: clean(i?.timePerWeek, 200),
    sessionLength: clean(i?.sessionLength, 200),
    priorExperience: clean(i?.priorExperience),
    preferences: clean(i?.preferences),
    materialsMode: mode
  }
}

export class ClassService {
  constructor(private readonly k: Kernel) {}

  async list(): Promise<ClassSummary[]> {
    const metas = await this.k.repo.list()
    return Promise.all(
      metas.map(async (meta) => {
        const { curriculum, progress, next, due } = await this.k.summaryFields(meta.id)
        const topics = allTopics(curriculum)
        const nextTopic = next ? topics.find((t) => t.id === next) : undefined
        return {
          id: meta.id,
          title: meta.title,
          stage: meta.stage,
          topic: meta.mission.topic,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          hue: meta.hue,
          topicsTotal: topics.length,
          topicsMastered: topics.filter((t) => progress[t.id]?.status === 'mastered').length,
          reviewsDue: due.length,
          nextTopic: nextTopic ? { id: nextTopic.id, title: nextTopic.title } : null,
          independence: await this.k.independence(meta.id)
        }
      })
    )
  }

  async get(classId: string): Promise<ClassBundle> {
    const repo = this.k.repo
    const meta = await repo.requireMeta(classId)
    const [sources, sourceProposals, diagnostic, curriculumProposals, sessions, threads, annotations, records, glossary, notes, explorables, helpEvents] = await Promise.all([
      repo.read(classId, 'sources'),
      repo.read(classId, 'proposals'),
      repo.read(classId, 'diagnostic'),
      repo.read(classId, 'curriculumProposals'),
      repo.read(classId, 'sessions'),
      repo.read(classId, 'threads'),
      repo.read(classId, 'annotations'),
      repo.read(classId, 'records'),
      repo.read(classId, 'glossary'),
      repo.read(classId, 'notes'),
      repo.read(classId, 'explorables'),
      repo.read(classId, 'helpEvents')
    ])
    const { curriculum, progress, next, due } = await this.k.summaryFields(classId)
    return {
      meta,
      sources,
      sourceProposals,
      diagnostic,
      curriculum,
      curriculumProposals,
      progress,
      sessions,
      threads,
      annotations,
      records,
      glossary,
      notes,
      explorables,
      independence: await this.k.independence(classId),
      helpEvents,
      nextTopicId: next,
      reviewsDue: due
    }
  }

  async create(input: { title: string; mission: Mission; intake: Intake }): Promise<ClassMeta> {
    const mission = sanitizeMission(input.mission)
    const title = clean(input.title, 120) || mission.topic
    if (!title) throw userError('Give the class a name or a topic.')
    const settings = await this.k.settings.get()
    const now = nowIso()
    const meta: ClassMeta = {
      id: newId('class'),
      title,
      createdAt: now,
      updatedAt: now,
      stage: 'intake',
      mission,
      intake: sanitizeIntake(input.intake),
      trustedDomains: [...settings.trustedDomains],
      hue: Math.floor(Math.random() * 360)
    }
    await this.k.repo.writeMeta(meta)
    this.k.changed(meta.id)
    return meta
  }

  async update(classId: string, patch: { title?: string; mission?: Mission; intake?: Intake; trustedDomains?: string[] }): Promise<ClassMeta> {
    return this.k.repo.lock(classId, async () => {
      const meta = await this.k.repo.requireMeta(classId)
      const next: ClassMeta = {
        ...meta,
        title: patch.title !== undefined ? clean(patch.title, 120) || meta.title : meta.title,
        mission: patch.mission ? sanitizeMission(patch.mission) : meta.mission,
        intake: patch.intake ? sanitizeIntake(patch.intake) : meta.intake,
        trustedDomains: patch.trustedDomains ? Array.from(new Set(patch.trustedDomains.map(normalizeDomain).filter(Boolean))) : meta.trustedDomains,
        updatedAt: nowIso()
      }
      await this.k.repo.writeMeta(next)
      this.k.changed(classId)
      return next
    })
  }

  async remove(classId: string): Promise<void> {
    this.k.cancelExports(classId)
    await this.k.repo.lock(classId, () => this.k.repo.removeClass(classId))
    this.k.emitter.classChanged(classId)
  }

  /** Mark a class as recently used (sorts it to the top). */
  async activate(classId: string): Promise<void> {
    await this.k.repo.lock(classId, async () => this.k.touch(await this.k.repo.requireMeta(classId)))
  }
}
