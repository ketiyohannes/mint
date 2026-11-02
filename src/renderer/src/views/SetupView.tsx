import { useEffect, useState, type JSX, type ReactNode } from 'react'
import type { ClassBundle } from '@shared/types'
import { useApp } from '../state/app'
import { api } from '../lib/api'
import { Icon } from '../components/Icon'
import { AddMaterials, SourceList, TrustedSources } from '../components/Materials'
import { CurriculumReview } from '../components/CurriculumReview'

/** Intake inside the class: materials, diagnostic, plan approval. */
export function SetupView({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const { run } = useApp()
  const classId = bundle.meta.id
  const mode = bundle.meta.intake.materialsMode
  const hasSources = bundle.sources.length > 0
  const diag = bundle.diagnostic
  const diagDone = Boolean(diag?.result)
  const pending = bundle.curriculumProposals.find((p) => p.status === 'pending')
  const [answers, setAnswers] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (diag && !diag.result) setAnswers((a) => (a.length === diag.questions.length ? a : diag.questions.map((_, i) => a[i] ?? '')))
  }, [diag])

  const step = !hasSources ? 0 : !diagDone ? 1 : 2

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    await run(fn)
    setBusy(null)
  }

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 860 }}>
        <div className="stack" style={{ gap: 26 }}>
          <Step n={1} title="Add your materials" state={step > 0 ? 'done' : 'current'}>
            {mode !== 'trusted' && <AddMaterials bundle={bundle} />}
            {mode !== 'own' && (
              <div style={{ marginTop: mode === 'mixed' ? 16 : 0 }}>
                <div className="label" style={{ marginBottom: 8 }}>
                  Build from trusted sources
                </div>
                <TrustedSources bundle={bundle} />
              </div>
            )}
            {mode === 'trusted' && (
              <details className="small" style={{ marginTop: 10 }}>
                <summary className="muted">I have a file or link after all</summary>
                <div style={{ marginTop: 10 }}>
                  <AddMaterials bundle={bundle} />
                </div>
              </details>
            )}
            {hasSources && (
              <div style={{ marginTop: 16 }}>
                <div className="label" style={{ marginBottom: 8 }}>
                  In this class
                </div>
                <SourceList bundle={bundle} allowRemove />
              </div>
            )}
          </Step>

          <Step n={2} title="A short diagnostic" state={step > 1 ? 'done' : step === 1 ? 'current' : 'todo'}>
            {step < 1 ? (
              <div className="hint">Add at least one source first.</div>
            ) : diagDone ? (
              <div className="small">
                <b>{diag!.result!.startingLevel}.</b> {diag!.result!.summary}
              </div>
            ) : !diag || !diag.questions.length ? (
              <div className="row">
                <button className="btn primary" disabled={busy !== null} onClick={() => act('diag', () => api.intake.startDiagnostic(classId))} data-testid="start-diagnostic">
                  {busy === 'diag' ? <span className="spinner" /> : <Icon name="help" />} Start diagnostic
                </button>
                <button className="btn ghost" disabled={busy !== null} onClick={() => act('skip', () => api.intake.skipDiagnostic(classId))} data-testid="skip-diagnostic">
                  Skip
                </button>
                <span className="hint">3 or 4 quick questions so the plan fits you. "I don't know" is a great answer.</span>
              </div>
            ) : (
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault()
                  void act('submit', () => api.intake.submitDiagnostic(classId, answers))
                }}
              >
                {diag.questions.map((q, i) => (
                  <div className="field" key={i} style={{ marginBottom: 4 }}>
                    <label htmlFor={`dq${i}`}>
                      {i + 1}. {q}
                    </label>
                    <textarea
                      id={`dq${i}`}
                      className="textarea"
                      style={{ minHeight: 60 }}
                      value={answers[i] ?? ''}
                      onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
                      data-testid="diagnostic-answer"
                    />
                  </div>
                ))}
                <div className="row">
                  <button className="btn primary" disabled={busy !== null} data-testid="submit-diagnostic">
                    {busy === 'submit' ? <span className="spinner" /> : <Icon name="check" />} Submit answers
                  </button>
                </div>
              </form>
            )}
          </Step>

          <Step n={3} title="Approve your curriculum" state={step === 2 ? 'current' : 'todo'}>
            {step < 2 ? (
              <div className="hint">Comes after the diagnostic.</div>
            ) : pending ? (
              <CurriculumReview bundle={bundle} proposal={pending} />
            ) : (
              <div className="row">
                <button className="btn primary" disabled={busy !== null} onClick={() => act('plan', () => api.intake.proposeCurriculum(classId))} data-testid="plan-curriculum">
                  {busy === 'plan' ? <span className="spinner" /> : <Icon name="sparkle" />} Plan my curriculum
                </button>
                <span className="hint">The tutor reads your materials and proposes milestones. You approve or ask for changes.</span>
              </div>
            )}
          </Step>
        </div>
      </div>
    </div>
  )
}

function Step({ n, title, state, children }: { n: number; title: string; state: 'done' | 'current' | 'todo'; children: ReactNode }): JSX.Element {
  return (
    <section className="checklist-item">
      <div className={`checklist-num ${state === 'done' ? 'done' : state === 'current' ? 'current' : ''}`}>{state === 'done' ? <Icon name="check" size={14} /> : n}</div>
      <div style={{ flex: 1, minWidth: 0, opacity: state === 'todo' ? 0.6 : 1 }}>
        <h2 className="serif" style={{ fontSize: 20, marginBottom: 10, marginTop: 2 }}>
          {title}
        </h2>
        {children}
      </div>
    </section>
  )
}
