import { quickStreamId } from '@shared/mode'
import { UNNAMED_CLASS, type QuickCourse } from '@shared/types'
import { planQuickCourse, writeQuickSection } from '../jobs'
import { cleanSectionBody, validateQuickPlan } from '../learning/quick'
import { AgentError } from '../agents/types'
import { nowIso } from '../store/fsutil'
import type { Kernel } from './kernel'
import { notice, userError, userMessage } from './kernel'

/**
 * Quick mode: a short course written from the learner's description. The
 * model plans it once (code validates the plan), then writes it part by part
 * in the background; each part is stored as it is finished, so a stop, a
 * failure or a restart keeps what was written and can go on from there.
 */
export class QuickCourseService {
  /** Classes whose course is being planned. */
  private planning = new Set<string>()
  /** Classes whose course is being written, each with the way to stop it. */
  private writing = new Map<string, { controller: AbortController; done: Promise<void> }>()

  constructor(private readonly k: Kernel) {}

  /** Plan a course from the learner's words and store it, ready to be written. `minutes` is the reading time they asked for, if any. */
  async plan(classId: string, request: string, minutes: number | null, signal?: AbortSignal): Promise<QuickCourse> {
    if (this.planning.has(classId) || this.writing.has(classId)) throw userError('This course is already being written.')
    this.planning.add(classId)
    try {
      const ctx = await this.k.context(classId)
      const raw = await this.k.job(classId, 'Planning your course', async () => planQuickCourse({ runtime: await this.k.runtime(), ctx, signal }, request, minutes))
      const course = validateQuickPlan(raw, request, minutes)
      if (!course) throw userError('The plan for the course came back empty. Try again.')
      await this.k.repo.lock(classId, async () => {
        const meta = await this.k.repo.requireMeta(classId)
        await this.k.repo.write(classId, 'quickCourse', course)
        // The class is named after its course, unless the learner already named it.
        const title = meta.title === UNNAMED_CLASS ? course.title : meta.title
        await this.k.repo.writeMeta({ ...meta, title, stage: 'active', mission: { ...meta.mission, topic: course.title, why: course.request.slice(0, 2000) }, updatedAt: nowIso() })
      })
      this.k.changed(classId)
      return course
    } finally {
      this.planning.delete(classId)
    }
  }

  /** Write the parts that are not written yet, in the background. One run per class. */
  write(classId: string): void {
    if (this.writing.has(classId)) return
    const controller = new AbortController()
    const done = this.run(classId, controller.signal)
      .catch((err) => notice(this.k, classId, 'Writing your course', err))
      .finally(() => this.writing.delete(classId))
    this.writing.set(classId, { controller, done })
  }

  /** Stop writing. The parts already written stay, and `resume` writes the rest. */
  async stop(classId: string): Promise<void> {
    const run = this.writing.get(classId)
    if (!run) return this.setStatus(classId, (c) => (c.status === 'writing' ? { ...c, status: 'stopped' } : c))
    run.controller.abort()
    await run.done
  }

  async resume(classId: string): Promise<void> {
    const course = await this.k.repo.read(classId, 'quickCourse')
    if (!course) throw userError('There is no course to continue yet.')
    if (course.sections.every((s) => s.body !== undefined)) return this.setStatus(classId, (c) => ({ ...c, status: 'ready', error: undefined }))
    await this.setStatus(classId, (c) => ({ ...c, status: 'writing', error: undefined }))
    this.write(classId)
  }

  /**
   * A course still marked as being written with no run under way was cut off
   * (mint quit meanwhile). It shows as stopped, so the learner can continue it.
   */
  async recover(classId: string): Promise<void> {
    if (this.writing.has(classId) || this.planning.has(classId)) return
    const course = await this.k.repo.read(classId, 'quickCourse')
    if (course?.status === 'writing') await this.setStatus(classId, (c) => (c.status === 'writing' && !this.writing.has(classId) ? { ...c, status: 'stopped' } : c))
  }

  /** Settles when the class's course is no longer being written (tests wait on it). */
  idle(classId: string): Promise<void> {
    return this.writing.get(classId)?.done ?? Promise.resolve()
  }

  private async run(classId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.k.job(classId, 'Writing your course', async () => {
        for (;;) {
          const course = await this.k.repo.read(classId, 'quickCourse')
          const index = course ? course.sections.findIndex((s) => s.body === undefined) : -1
          if (!course || index < 0) return
          const section = course.sections[index]
          const streamId = quickStreamId(classId, section.id)
          const ctx = await this.k.context(classId)
          const text = await writeQuickSection({ runtime: await this.k.runtime(), ctx, signal }, course, index, (delta) => {
            if (!signal.aborted) this.k.emitter.stream({ streamId, delta })
          })
          if (signal.aborted) throw new AgentError('Cancelled', 'aborted')
          const body = cleanSectionBody(text)
          if (!body) throw userError(`Part ${index + 1} came back empty.`)
          await this.setStatus(classId, (c) => ({ ...c, sections: c.sections.map((s) => (s.id === section.id ? { ...s, body } : s)) }))
        }
      })
      await this.setStatus(classId, (c) => ({ ...c, status: 'ready', error: undefined }))
    } catch (err) {
      // A class deleted while its course was being written has nothing left to mark or to report.
      if (!(await this.k.repo.readMeta(classId))) return
      const stopped = err instanceof AgentError && err.kind === 'aborted'
      await this.setStatus(classId, (c) => (stopped ? { ...c, status: 'stopped' } : { ...c, status: 'failed', error: userMessage(err) }))
      if (!stopped) throw err
    }
  }

  private async setStatus(classId: string, fn: (course: QuickCourse) => QuickCourse): Promise<void> {
    const stored = await this.k.repo.lock(classId, async () => {
      // The class may be gone by now (deleted while its course was being written).
      if (!(await this.k.repo.readMeta(classId))) return false
      await this.k.repo.update(classId, 'quickCourse', (c) => (c ? { ...fn(c), updatedAt: nowIso() } : c))
      return true
    })
    if (stored) this.k.changed(classId)
  }
}
