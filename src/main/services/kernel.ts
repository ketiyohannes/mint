import type { ClassMeta, IndependenceState, ProgressEvent, ProviderId, Settings, StreamEvent } from '@shared/types'
import type { AgentRuntime } from '../agents/types'
import { ClaudeRuntime } from '../agents/claude'
import { CodexRuntime } from '../agents/codex/runtime'
import { DemoRuntime } from '../agents/demo'
import { ClassRepo } from '../store/classRepo'
import { SettingsStore } from '../store/settingsStore'
import { appendHistory, computeIndependence, nextTopicId, recomputeProgress, reviewsDue } from '../learning/engine'
import type { ClassContext } from '../jobs/context'
import { curriculumMd, glossaryMd, missionMd, noteFileName, noteMd, recordFileName, recordMd, resourcesMd } from '../store/exports'
import type { YouTubeClient } from '../sources'
import { newId, nowIso } from '../store/fsutil'

export interface Emitter {
  stream(e: StreamEvent): void
  progress(e: ProgressEvent): void
  classChanged(classId: string): void
}

export interface KernelOptions {
  /** Injected fetch for URL imports (tests use fixtures; the app uses the real network). */
  fetchImpl?: typeof fetch
  youtube?: YouTubeClient
  log?: (msg: string) => void
}

/**
 * Shared plumbing for all services: storage, settings, the active agent
 * runtime, derived learning state, events, and /teach-style exports.
 */
export class Kernel {
  private runtimeCache: { key: string; runtime: AgentRuntime } | null = null
  private exportTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    readonly repo: ClassRepo,
    readonly settings: SettingsStore,
    readonly emitter: Emitter,
    readonly opts: KernelOptions = {}
  ) {}

  log(msg: string): void {
    this.opts.log?.(msg)
  }

  /** The runtime for the provider selected in Settings (recreated when settings change). */
  async runtime(provider?: ProviderId): Promise<AgentRuntime> {
    const s = await this.settings.get()
    const p = provider ?? s.provider
    const apiKey = p === 'claude' ? await this.settings.getSecret('anthropic') : null
    const key = JSON.stringify([p, s.claudeModel, s.codexModel, Boolean(apiKey), apiKey?.slice(-6)])
    if (this.runtimeCache?.key === key) return this.runtimeCache.runtime
    const runtime = this.createRuntime(p, s, apiKey)
    if (!provider) {
      const old = this.runtimeCache
      this.runtimeCache = { key, runtime }
      if (old) void old.runtime.dispose().catch(() => undefined)
    }
    return runtime
  }

  private createRuntime(p: ProviderId, s: Settings, apiKey: string | null): AgentRuntime {
    if (p === 'demo') return new DemoRuntime()
    if (p === 'codex') return new CodexRuntime({ model: s.codexModel || undefined, log: (m) => this.log(`[codex] ${m}`) })
    return new ClaudeRuntime({ model: s.claudeModel || undefined, apiKey, log: (m) => this.log(`[claude] ${m}`) })
  }

  async dispose(): Promise<void> {
    await this.runtimeCache?.runtime.dispose().catch(() => undefined)
    for (const t of this.exportTimers.values()) clearTimeout(t)
  }

  /** Everything a job needs to know about a class. */
  async context(classId: string): Promise<ClassContext> {
    const repo = this.repo
    const [meta, sources, curriculum, progressRaw, records, glossary] = await Promise.all([
      repo.requireMeta(classId),
      repo.read(classId, 'sources'),
      repo.read(classId, 'curriculum'),
      repo.read(classId, 'progress'),
      repo.read(classId, 'records'),
      repo.read(classId, 'glossary')
    ])
    const outlines = await Promise.all(
      sources.map(async (m) => {
        try {
          const doc = await repo.readSource(classId, m.id)
          return { meta: m, sectionLabels: doc.sections.map((s) => s.label) }
        } catch {
          return { meta: m, sectionLabels: [] }
        }
      })
    )
    return {
      dir: repo.dir(classId),
      meta,
      sources: outlines,
      curriculum,
      progress: recomputeProgress(curriculum, progressRaw),
      records,
      glossary,
      independence: await this.independence(classId)
    }
  }

  async independence(classId: string): Promise<IndependenceState> {
    const [events, sessions, history] = await Promise.all([
      this.repo.read(classId, 'helpEvents'),
      this.repo.read(classId, 'sessions'),
      this.repo.read(classId, 'independenceHistory')
    ])
    return computeIndependence(events, sessions, history)
  }

  /** Record the current independence score in the trend history (call under the class lock). */
  async snapshotIndependence(classId: string): Promise<void> {
    const state = await this.independence(classId)
    await this.repo.update(classId, 'independenceHistory', (h) => appendHistory(h, state.score))
  }

  /** Recompute stored progress from the curriculum (call under the class lock). */
  async refreshProgress(classId: string): Promise<void> {
    const curriculum = await this.repo.read(classId, 'curriculum')
    await this.repo.update(classId, 'progress', (p) => recomputeProgress(curriculum, p))
  }

  async summaryFields(classId: string) {
    const [curriculum, progressRaw] = await Promise.all([this.repo.read(classId, 'curriculum'), this.repo.read(classId, 'progress')])
    const progress = recomputeProgress(curriculum, progressRaw)
    return { curriculum, progress, next: nextTopicId(curriculum, progress), due: reviewsDue(progress) }
  }

  async touch(meta: ClassMeta): Promise<void> {
    await this.repo.writeMeta({ ...meta, updatedAt: nowIso() })
  }

  /** Notify the renderer and schedule regeneration of the markdown exports. */
  changed(classId: string): void {
    this.emitter.classChanged(classId)
    const pending = this.exportTimers.get(classId)
    if (pending) clearTimeout(pending)
    this.exportTimers.set(
      classId,
      setTimeout(() => {
        this.exportTimers.delete(classId)
        void this.writeExports(classId).catch((err) => this.log(`export failed: ${String(err)}`))
      }, 400)
    )
  }

  async writeExports(classId: string): Promise<void> {
    const meta = await this.repo.readMeta(classId)
    if (!meta) return
    const [sources, proposals, curriculum, glossary, records, notes] = await Promise.all([
      this.repo.read(classId, 'sources'),
      this.repo.read(classId, 'proposals'),
      this.repo.read(classId, 'curriculum'),
      this.repo.read(classId, 'glossary'),
      this.repo.read(classId, 'records'),
      this.repo.read(classId, 'notes')
    ])
    const writes: Promise<void>[] = [
      this.repo.writeExport(classId, 'MISSION.md', missionMd(meta)),
      this.repo.writeExport(classId, 'RESOURCES.md', resourcesMd(meta, sources, proposals)),
      this.repo.writeExport(classId, 'GLOSSARY.md', glossaryMd(meta, glossary))
    ]
    if (curriculum) writes.push(this.repo.writeExport(classId, 'CURRICULUM.md', curriculumMd(curriculum, sources)))
    // Rebuild generated folders from scratch so deleted items disappear.
    await Promise.all(['learning-records', 'notes', 'reference'].map((d) => this.repo.removeExport(classId, d)))
    for (const r of records) writes.push(this.repo.writeExport(classId, recordFileName(r), recordMd(r, records)))
    for (const n of notes) writes.push(this.repo.writeExport(classId, noteFileName(n), noteMd(n)))
    await Promise.all(writes)
  }

  /** Run a background job with progress events; errors are reported, then rethrown. */
  async job<T>(classId: string, label: string, fn: () => Promise<T>): Promise<T> {
    const jobId = newId('job')
    this.emitter.progress({ classId, jobId, label, state: 'running' })
    try {
      const out = await fn()
      this.emitter.progress({ classId, jobId, label, state: 'done' })
      return out
    } catch (err) {
      this.emitter.progress({ classId, jobId, label, state: 'error', detail: userMessage(err) })
      throw err
    }
  }
}

/** Strip the internal prefix from user-facing errors. */
export function userMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.startsWith('mint:') ? msg.slice(5) : msg
}

/** Throw an error whose message is safe and helpful to show the learner. */
export function userError(message: string): Error {
  return new Error(`mint:${message}`)
}
