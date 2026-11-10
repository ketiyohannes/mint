import type { CurriculumProposal, Diagnostic } from '@shared/types'
import { assessDiagnostic, diagnosticQuestions, planCurriculum } from '../jobs'
import { validateCurriculum } from '../learning/curriculum'
import { newId, nowIso } from '../store/fsutil'
import type { Kernel } from './kernel'
import { userError } from './kernel'
import { appendRecords } from './records'

export class IntakeService {
  constructor(private readonly k: Kernel) {}

  async startDiagnostic(classId: string): Promise<void> {
    const ctx = await this.k.context(classId)
    if (!ctx.sources.length) throw userError('Add at least one source first, so the diagnostic can be about your materials.')
    const out = await this.k.job(classId, 'Writing a short diagnostic', async () => diagnosticQuestions({ runtime: await this.k.runtime(), ctx }))
    const questions = out.questions
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, 5)
    if (!questions.length) throw userError('The tutor could not write diagnostic questions. Try again.')
    await this.k.repo.lock(classId, () => this.k.repo.write(classId, 'diagnostic', { questions, answers: questions.map(() => '') }))
    this.k.changed(classId)
  }

  async submitDiagnostic(classId: string, answers: string[]): Promise<void> {
    const current = await this.k.repo.read(classId, 'diagnostic')
    if (!current) throw userError('Start the diagnostic first.')
    const diag: Diagnostic = { ...current, answers: current.questions.map((_, i) => String(answers[i] ?? '').slice(0, 4000)) }
    const ctx = await this.k.context(classId)
    const result = await this.k.job(classId, 'Reading your answers', async () => assessDiagnostic({ runtime: await this.k.runtime(), ctx }, diag))
    await this.k.repo.lock(classId, async () => {
      await this.k.repo.write(classId, 'diagnostic', { ...diag, result })
      // Diagnostic findings are learner-stated evidence, so they become records directly.
      await appendRecords(this.k, classId, result.records)
    })
    this.k.changed(classId)
  }

  async skipDiagnostic(classId: string): Promise<void> {
    await this.k.repo.lock(classId, () =>
      this.k.repo.write(classId, 'diagnostic', {
        questions: [],
        answers: [],
        result: { summary: 'Diagnostic skipped. The plan starts from the foundations and adapts as you go.', startingLevel: 'unknown', records: [] }
      })
    )
    this.k.changed(classId)
  }

  /** The model proposes; code validates and repairs; the learner decides. */
  async proposeCurriculum(classId: string, reason?: string): Promise<void> {
    const ctx = await this.k.context(classId)
    if (!ctx.sources.length) throw userError('Add at least one source before planning.')
    const diag = await this.k.repo.read(classId, 'diagnostic')
    const why = reason?.trim() || (ctx.curriculum ? 'Revise the plan based on recent evidence.' : 'Create the first plan from the intake.')
    const raw = await this.k.job(classId, ctx.curriculum ? 'Revising your curriculum' : 'Planning your curriculum', async () => planCurriculum({ runtime: await this.k.runtime(), ctx }, diag, why))
    const { curriculum, repairs } = validateCurriculum(
      { ...raw, milestones: raw.milestones.map((m) => ({ ...m, topics: m.topics.map((t) => ({ ...t, sources: t.sources.map((s) => ({ ...s, note: s.note || undefined })) })) })) },
      ctx.sources,
      ctx.curriculum
    )
    if (!curriculum.milestones.length) throw userError('The plan came back empty. Try again.')
    const proposal: CurriculumProposal = { id: newId('plan'), createdAt: nowIso(), reason: why, curriculum, status: 'pending', repairs }
    await this.k.repo.lock(classId, () =>
      this.k.repo.update(classId, 'curriculumProposals', (list) => [...list.map((p) => (p.status === 'pending' ? { ...p, status: 'rejected' as const } : p)), proposal])
    )
    this.k.changed(classId)
  }

  async resolveCurriculum(classId: string, proposalId: string, accept: boolean): Promise<void> {
    await this.k.repo.lock(classId, async () => {
      const proposals = await this.k.repo.read(classId, 'curriculumProposals')
      const target = proposals.find((p) => p.id === proposalId)
      if (!target || target.status !== 'pending') throw userError('That plan is no longer pending.')
      await this.k.repo.write(
        classId,
        'curriculumProposals',
        proposals.map((p) => (p.id === proposalId ? { ...p, status: accept ? ('accepted' as const) : ('rejected' as const) } : p))
      )
      if (!accept) return
      await this.k.repo.write(classId, 'curriculum', target.curriculum)
      await this.k.refreshProgress(classId)
      const meta = await this.k.repo.requireMeta(classId)
      await this.k.repo.writeMeta({ ...meta, stage: 'active', updatedAt: nowIso() })
    })
    this.k.changed(classId)
  }
}
