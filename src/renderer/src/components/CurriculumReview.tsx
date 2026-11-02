import { useState, type JSX } from 'react'
import type { ClassBundle, Curriculum, CurriculumProposal } from '@shared/types'
import { diffCurricula } from '@shared/curriculum'
import { useApp } from '../state/app'
import { api } from '../lib/api'
import { Icon } from './Icon'

/** Show a proposed curriculum; the learner approves or asks for changes. */
export function CurriculumReview({ bundle, proposal }: { bundle: ClassBundle; proposal: CurriculumProposal }): JSX.Element {
  const { run } = useApp()
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState<null | 'accept' | 'revise' | 'reject'>(null)
  const classId = bundle.meta.id
  const diff = bundle.curriculum ? diffCurricula(bundle.curriculum, proposal.curriculum) : null

  async function act(kind: 'accept' | 'revise' | 'reject') {
    setBusy(kind)
    if (kind === 'accept') await run(() => api.intake.resolveCurriculum(classId, proposal.id, true), 'Plan approved.')
    else if (kind === 'reject') await run(() => api.intake.resolveCurriculum(classId, proposal.id, false))
    else await run(() => api.intake.proposeCurriculum(classId, feedback.trim() || 'Revise the plan.'))
    setBusy(null)
    setFeedback('')
  }

  return (
    <div className="card" data-testid="curriculum-proposal">
      <div className="card-title">
        <Icon name="path" /> {bundle.curriculum ? 'Proposed update to your plan' : 'Your proposed plan'}
        <span className="spacer" />
        <span className="badge">v{proposal.curriculum.version}</span>
      </div>
      <p className="small muted" style={{ marginTop: -4 }}>
        Reason: {proposal.reason}
      </p>
      {diff && (
        <div className="row wrap small" style={{ marginBottom: 10 }}>
          {diff.added.length > 0 && <span className="badge green">+ {diff.added.join(', ')}</span>}
          {diff.removed.length > 0 && <span className="badge red">− {diff.removed.join(', ')}</span>}
          {diff.moved.length > 0 && <span className="badge amber">moved: {diff.moved.join(', ')}</span>}
          {!diff.added.length && !diff.removed.length && !diff.moved.length && <span className="badge">Same topics, refined details</span>}
        </div>
      )}
      <CurriculumOutline bundle={bundle} curriculum={proposal.curriculum} />
      {proposal.repairs.length > 0 && (
        <details className="small" style={{ marginTop: 10 }}>
          <summary className="muted">mint corrected {proposal.repairs.length} thing(s) in the plan</summary>
          <ul>
            {proposal.repairs.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="divider" />
      <div className="field" style={{ marginBottom: 10 }}>
        <label htmlFor="plan-feedback">Want changes? Say what to change</label>
        <textarea
          id="plan-feedback"
          className="textarea"
          style={{ minHeight: 56 }}
          placeholder="e.g. Skip the history, I know the basics. Add more practice on proofs."
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      </div>
      <div className="row">
        <button className="btn primary" onClick={() => act('accept')} disabled={busy !== null} data-testid="approve-plan">
          {busy === 'accept' ? <span className="spinner" /> : <Icon name="check" />} Approve plan
        </button>
        <button className="btn" onClick={() => act('revise')} disabled={busy !== null || !feedback.trim()}>
          {busy === 'revise' ? <span className="spinner" /> : <Icon name="refresh" />} Revise with my feedback
        </button>
        {bundle.curriculum && (
          <button className="btn ghost" onClick={() => act('reject')} disabled={busy !== null}>
            Keep current plan
          </button>
        )}
      </div>
    </div>
  )
}

export function CurriculumOutline({ bundle, curriculum }: { bundle: ClassBundle; curriculum: Curriculum }): JSX.Element {
  const title = (id: string) => bundle.sources.find((s) => s.id === id)?.title ?? 'missing source'
  return (
    <div className="stack" style={{ gap: 14 }}>
      <p style={{ margin: 0 }}>{curriculum.summary}</p>
      {curriculum.project && (
        <div className="banner" style={{ padding: '10px 14px' }}>
          <Icon name="target" />
          <div>
            <b>Project: {curriculum.project.title}.</b> {curriculum.project.deliverable}
          </div>
        </div>
      )}
      {curriculum.milestones.map((m, i) => (
        <div key={m.id}>
          <div className="milestone-head">
            <span className="num">Milestone {i + 1}</span>
            <h3>{m.title}</h3>
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            Deliverable: {m.deliverable}
          </div>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {m.topics.map((t) => (
              <li key={t.id} style={{ marginBottom: 6 }}>
                <b>{t.title}</b>: <span className="muted">{t.objective}</span>
                {t.sources.length > 0 && (
                  <div className="small muted">
                    Read: {t.sources.map((s) => `${title(s.sourceId)} (${s.section})`).join('; ')}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
      {curriculum.assumptions.length > 0 && (
        <div className="small">
          <b>Assumptions:</b> {curriculum.assumptions.join(' · ')}
        </div>
      )}
      {curriculum.cadence && (
        <div className="small">
          <b>Cadence:</b> {curriculum.cadence}
        </div>
      )}
    </div>
  )
}
