import { UNNAMED_CLASS, type ClassMeta } from '@shared/types'
import { titleFromPaths } from '../sources/expand'
import { domainOf } from '../sources'
import type { ClassService } from './classes'
import type { IntakeService } from './intake'
import type { SourceService } from './sources'
import type { Kernel } from './kernel'
import { notice, userError } from './kernel'

export interface StartClassInput {
  title?: string
  goal?: string
  paths?: string[]
  urls?: string[]
}

/**
 * Project-style class creation: open a folder (or nothing) and start.
 * Materials import in the background; the intake happens in the chat
 * (ChatService), which then asks for a plan. The plan is applied directly
 * and stays adjustable.
 */
export class SetupService {
  private planning = new Map<string, Promise<void>>()
  /** Classes whose materials, picked at creation, are still being imported. */
  private importing = new Map<string, Promise<void>>()
  /** Called after a class gets its first plan (the chat announces it). */
  onPlanned?: (classId: string) => Promise<void>

  constructor(
    private readonly k: Kernel,
    private readonly classes: ClassService,
    private readonly sources: SourceService,
    private readonly intake: IntakeService
  ) {}

  async start(input: StartClassInput): Promise<ClassMeta> {
    const paths = (Array.isArray(input?.paths) ? input.paths : []).map(String).filter(Boolean).slice(0, 200)
    const urls = (Array.isArray(input?.urls) ? input.urls : [])
      .map((u) => String(u).trim())
      .filter(Boolean)
      .slice(0, 20)
    const bad = urls.find((u) => !/^https?:\/\//i.test(u))
    if (bad) throw userError(`Links must start with http:// or https:// ("${bad.slice(0, 80)}").`)
    const goal = String(input?.goal ?? '').trim()
    const title = String(input?.title ?? '').trim() || (await titleFromPaths(paths)) || (urls[0] ? domainOf(urls[0]) : '') || goal.slice(0, 80) || UNNAMED_CLASS
    const hasMaterials = paths.length > 0 || urls.length > 0
    const meta = await this.classes.create({
      title,
      mission: { topic: title, why: goal, successLooksLike: [], constraints: [], outOfScope: [] },
      intake: { timeline: '', timePerWeek: '', sessionLength: '30 minutes', priorExperience: '', preferences: '', materialsMode: hasMaterials ? 'own' : 'trusted' }
    })
    const run = this.bootstrap(meta.id, paths, urls)
      .catch((err) => notice(this.k, meta.id, 'Setting up the class', err))
      .finally(() => this.importing.delete(meta.id))
    this.importing.set(meta.id, run)
    return meta
  }

  /**
   * Settles once the materials picked at creation are imported (at once when
   * none are). The intake waits on it: asked or answered earlier, it would
   * see a class with no materials and go looking for trusted sources instead.
   */
  imported(classId: string): Promise<void> {
    return this.importing.get(classId) ?? Promise.resolve()
  }

  private async bootstrap(classId: string, paths: string[], urls: string[]): Promise<void> {
    if (paths.length) {
      const { errors } = await this.sources.addFiles(classId, paths)
      for (const e of errors) notice(this.k, classId, 'Import', e)
    }
    for (const url of urls) {
      try {
        await this.sources.addUrl(classId, url, 'user')
      } catch (err) {
        notice(this.k, classId, 'Import', err)
      }
    }
  }

  /** Plan (or re-plan) and apply the result. Concurrent requests for a class share one run. */
  plan(classId: string, reason?: string): Promise<void> {
    const running = this.planning.get(classId)
    if (running) return reason ? running.then(() => this.plan(classId, reason)) : running
    const run = this.runPlan(classId, reason).finally(() => this.planning.delete(classId))
    this.planning.set(classId, run)
    return run
  }

  /** Plan in the background once a class without a plan gets its first sources. */
  planIfUnplanned(classId: string): void {
    void (async () => {
      const [curriculum, sources, diagnostic] = await Promise.all([this.k.repo.read(classId, 'curriculum'), this.k.repo.read(classId, 'sources'), this.k.repo.read(classId, 'diagnostic')])
      // Plan only after the intake conversation (which records the diagnostic).
      if (!curriculum && sources.length && diagnostic) await this.plan(classId)
    })().catch((err) => notice(this.k, classId, 'Planning your curriculum', err))
  }

  private async runPlan(classId: string, reason?: string): Promise<void> {
    const first = !(await this.k.repo.read(classId, 'curriculum'))
    if (!(await this.k.repo.read(classId, 'diagnostic'))) await this.intake.skipDiagnostic(classId)
    await this.intake.proposeCurriculum(classId, reason)
    const pending = (await this.k.repo.read(classId, 'curriculumProposals')).find((p) => p.status === 'pending')
    if (pending) await this.intake.resolveCurriculum(classId, pending.id, true)
    if (first && pending) await this.onPlanned?.(classId)
  }
}
