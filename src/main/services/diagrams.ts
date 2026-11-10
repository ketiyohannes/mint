import type { Anchor, DiagramSpec, Explorable } from '@shared/types'
import { createDiagram, repairDiagram } from '../jobs'
import { slugify, newId, nowIso } from '../store/fsutil'
import type { DiagramOutput } from '../jobs/schemas'
import { cleanAnchor } from './anchors'
import type { Kernel } from './kernel'
import { userError } from './kernel'

const MAX_REPAIRS = 2

/** Code-side validation of a model-written diagram before it reaches the sandbox. */
export function sanitizeDiagram(out: DiagramOutput): DiagramSpec {
  const code = String(out.code ?? '')
  if (!code.trim()) throw userError('The diagram came back without any code.')
  if (code.length > 60_000) throw userError('The diagram code is too large.')
  const ids = new Set<string>()
  const elements = out.elements
    .map((e) => ({ id: String(e.id).trim().slice(0, 80), label: String(e.label).trim().slice(0, 80) || String(e.id), description: String(e.description ?? '').slice(0, 400) }))
    .filter((e) => e.id && !ids.has(e.id) && ids.add(e.id))
    .slice(0, 16)
  const pids = new Set<string>()
  const params = out.params
    .filter((p) => Number.isFinite(p.min) && Number.isFinite(p.max) && p.max > p.min)
    .map((p) => {
      const id = String(p.id).trim().slice(0, 60) || slugify(p.label, 30)
      const step = Number.isFinite(p.step) && p.step > 0 ? Math.min(p.step, p.max - p.min) : (p.max - p.min) / 100
      const value = Math.min(p.max, Math.max(p.min, Number.isFinite(p.value) ? p.value : p.min))
      return { id, label: String(p.label).slice(0, 60) || id, min: p.min, max: p.max, step, value }
    })
    .filter((p) => !pids.has(p.id) && pids.add(p.id))
    .slice(0, 6)
  return {
    engine: out.engine === 'three' ? 'three' : 'p5',
    title: String(out.title).trim().slice(0, 120) || 'Explorable',
    code,
    elements,
    params,
    caption: String(out.caption ?? '')
      .trim()
      .slice(0, 300)
  }
}

export class DiagramService {
  constructor(private readonly k: Kernel) {}

  async create(classId: string, prompt: string, where?: Anchor, signal?: AbortSignal): Promise<Explorable> {
    const request = String(prompt ?? '')
      .trim()
      .slice(0, 2000)
    if (!request) throw userError('Say what the diagram should show.')
    const ctx = await this.k.context(classId)
    // The anchor is stored with the diagram, so only its known, bounded shape is kept.
    const anchor = cleanAnchor(where)
    let anchorContext = ''
    if (anchor?.kind === 'source') anchorContext = `"${anchor.quote}" (source ${anchor.sourceId}, section [${anchor.sectionLabel}])`
    else if (anchor?.kind === 'message') anchorContext = `A tutor reply: "${anchor.quote}"`
    const out = await this.k.job(classId, 'Building an interactive diagram', async () => createDiagram({ runtime: await this.k.runtime(), ctx, signal }, request, anchorContext))
    const explorable: Explorable = {
      id: newId('exp'),
      classId,
      spec: sanitizeDiagram(out),
      prompt: request,
      anchor,
      kept: false,
      repairs: 0,
      createdAt: nowIso()
    }
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'explorables', (list) => [...list, explorable]))
    this.k.changed(classId)
    return explorable
  }

  /** The sandbox reported a runtime error: ask the agent to fix the code (bounded). */
  async repair(classId: string, explorableId: string, error: string): Promise<Explorable> {
    const current = (await this.k.repo.read(classId, 'explorables')).find((e) => e.id === explorableId)
    if (!current) throw userError('That diagram no longer exists.')
    if (current.repairs >= MAX_REPAIRS) throw userError('This diagram still fails after two repairs. Try asking for it differently.')
    const ctx = await this.k.context(classId)
    const out = await this.k.job(classId, 'Repairing the diagram', async () => repairDiagram({ runtime: await this.k.runtime(), ctx }, current.spec, error.slice(0, 2000)))
    const spec = sanitizeDiagram(out)
    let updated: Explorable | undefined
    await this.k.repo.lock(classId, () =>
      this.k.repo.update(classId, 'explorables', (list) =>
        list.map((e) => {
          if (e.id !== explorableId) return e
          updated = { ...e, spec, repairs: e.repairs + 1 }
          return updated
        })
      )
    )
    if (!updated) throw userError('That diagram no longer exists.')
    this.k.changed(classId)
    return updated
  }

  async setKept(classId: string, explorableId: string, kept: boolean): Promise<void> {
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'explorables', (list) => list.map((e) => (e.id === explorableId ? { ...e, kept } : e))))
    this.k.changed(classId)
  }

  async remove(classId: string, explorableId: string): Promise<void> {
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'explorables', (list) => list.filter((e) => e.id !== explorableId)))
    this.k.changed(classId)
  }
}
