import { listContents } from '../jobs'
import { validateContents } from '../learning/contents'
import type { Kernel } from './kernel'
import { notice, userError } from './kernel'

/**
 * Simple mode: the list of what a class's materials contain. The model
 * reads the materials and proposes the list; code validates it (real sources
 * and sections, stable ids) and stores it.
 */
export class ContentsService {
  private running = new Map<string, Promise<void>>()
  /** Classes whose materials changed while their list was being written: they are listed once more. */
  private stale = new Set<string>()

  constructor(private readonly k: Kernel) {}

  /** List the materials (again). Requests made while a class is being listed share that run. */
  refresh(classId: string): Promise<void> {
    const running = this.running.get(classId)
    if (running) return running
    const run = this.list(classId).finally(() => {
      this.running.delete(classId)
      if (this.stale.delete(classId)) this.refreshSoon(classId)
    })
    this.running.set(classId, run)
    return run
  }

  /** The materials changed: list them again in the background. */
  refreshSoon(classId: string): void {
    if (this.running.has(classId)) {
      this.stale.add(classId)
      return
    }
    void this.refresh(classId).catch((err) => notice(this.k, classId, 'Listing what is in your materials', err))
  }

  private async list(classId: string): Promise<void> {
    const ctx = await this.k.context(classId)
    if (!ctx.sources.length) {
      // Nothing left to list: the old list would point at sources that are gone.
      if (ctx.contents) await this.store(classId, null)
      return
    }
    const raw = await this.k.job(classId, 'Listing what is in your materials', async () => listContents({ runtime: await this.k.runtime(), ctx }))
    const contents = validateContents(raw, ctx.sources, ctx.contents)
    if (!contents.items.length) throw userError('The list came back empty. Try again.')
    await this.store(classId, contents)
  }

  private async store(classId: string, contents: ReturnType<typeof validateContents> | null): Promise<void> {
    await this.k.repo.lock(classId, () => this.k.repo.write(classId, 'contents', contents))
    this.k.changed(classId)
  }
}
