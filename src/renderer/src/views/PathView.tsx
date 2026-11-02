import { useState, type JSX } from 'react'
import { CHECK_KINDS, type ClassBundle, type Topic } from '@shared/types'
import { allTopics } from '@shared/curriculum'
import { useApp } from '../state/app'
import { api, dueLabel } from '../lib/api'
import { Icon } from '../components/Icon'
import { CurriculumReview } from '../components/CurriculumReview'

export function PathView({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const { run, go, focusSource } = useApp()
  const classId = bundle.meta.id
  const c = bundle.curriculum
  const [starting, setStarting] = useState<string | null>(null)
  const [reviseReason, setReviseReason] = useState('')
  const [revising, setRevising] = useState(false)
  const pending = bundle.curriculumProposals.find((p) => p.status === 'pending')
  const topics = allTopics(c)
  const next = topics.find((t) => t.id === bundle.nextTopicId)
  const openSession = bundle.sessions.find((s) => !s.endedAt)
  const openTopic = openSession ? topics.find((t) => t.id === openSession.topicId) : undefined
  const mastered = topics.filter((t) => bundle.progress[t.id]?.status === 'mastered').length

  async function start(topic: Topic, type: 'learn' | 'review') {
    setStarting(topic.id + type)
    const s = await run(() => api.sessions.start(classId, topic.id, type))
    setStarting(null)
    if (s) go({ name: 'class', classId, tab: 'study' })
  }

  async function revise() {
    setRevising(true)
    await run(() => api.intake.proposeCurriculum(classId, reviseReason.trim() || 'Revise the plan based on my recent evidence.'))
    setRevising(false)
    setReviseReason('')
  }

  if (!c) return <div className="page-inner empty">No curriculum yet.</div>

  return (
    <div className="page">
      <div className="page-inner">
        <div className="stack" style={{ gap: 18 }}>
          {openSession && openTopic ? (
            <div className="next-up">
              <Icon name="book" size={22} />
              <div style={{ flex: 1 }}>
                <div className="small muted">Session in progress</div>
                <div className="serif" style={{ fontSize: 20 }}>
                  {openTopic.title}
                </div>
              </div>
              <button className="btn primary" onClick={() => go({ name: 'class', classId, tab: 'study' })} data-testid="resume-session">
                Resume <Icon name="arrow" />
              </button>
            </div>
          ) : next ? (
            <div className="next-up">
              <Icon name="target" size={22} />
              <div style={{ flex: 1 }}>
                <div className="small muted">Next up</div>
                <div className="serif" style={{ fontSize: 20 }}>
                  {next.title}
                </div>
                <div className="small muted">{next.objective}</div>
              </div>
              <button className="btn primary" disabled={starting !== null} onClick={() => start(next, 'learn')} data-testid="start-session">
                {starting === next.id + 'learn' ? <span className="spinner" /> : <Icon name="play" size={14} />} Start session
              </button>
            </div>
          ) : (
            <div className="next-up">
              <Icon name="star" size={22} />
              <div style={{ flex: 1 }}>
                <div className="serif" style={{ fontSize: 20 }}>
                  {mastered === topics.length ? 'Every topic mastered.' : 'Nothing is unlocked right now.'}
                </div>
                <div className="small muted">
                  {mastered === topics.length
                    ? 'Keep up your spaced reviews, or extend the plan with a new milestone.'
                    : 'Finish the topics in progress to unlock the rest.'}
                </div>
              </div>
            </div>
          )}

          {bundle.reviewsDue.length > 0 && (
            <div className="card">
              <div className="card-title">
                <Icon name="clock" /> Reviews due
              </div>
              <div className="stack" style={{ gap: 6 }}>
                {bundle.reviewsDue.map((id) => {
                  const t = topics.find((x) => x.id === id)
                  if (!t) return null
                  return (
                    <div key={id} className="row">
                      <span style={{ flex: 1 }}>{t.title}</span>
                      <span className="small muted">{dueLabel(bundle.progress[id]?.nextReviewAt)}</span>
                      <button className="btn sm" disabled={starting !== null} onClick={() => start(t, 'review')} data-testid="start-review">
                        {starting === t.id + 'review' ? <span className="spinner" /> : null} Review
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {pending && <CurriculumReview bundle={bundle} proposal={pending} />}

          {c.project && (
            <div className="banner">
              <Icon name="target" />
              <div>
                <b>Project: {c.project.title}.</b> {c.project.deliverable}
              </div>
            </div>
          )}
        </div>

        <div className="row" style={{ margin: '28px 0 12px' }}>
          <h2 className="serif" style={{ fontSize: 21 }}>
            Curriculum <span className="muted small">v{c.version}</span>
          </h2>
          <span className="spacer" />
          <span className="small muted">
            {mastered}/{topics.length} mastered
          </span>
        </div>

        {c.milestones.map((m, i) => (
          <section className="milestone" key={m.id}>
            <div className="milestone-head">
              <span className="num">Milestone {i + 1}</span>
              <h3>{m.title}</h3>
            </div>
            <div className="small muted" style={{ margin: '-4px 0 6px 0' }}>
              Deliverable: {m.deliverable}
            </div>
            {m.topics.map((t) => {
              const p = bundle.progress[t.id]
              const status = p?.status ?? 'locked'
              const passed = CHECK_KINDS.filter((k) => p?.checks[k].passed).length
              return (
                <div className="topic-row" key={t.id} data-testid="topic-row">
                  <span className={`status-dot ${status}`} style={{ ['--pct' as string]: `${(passed / 3) * 100}%` }} title={status}>
                    {status === 'mastered' ? <Icon name="check" size={11} strokeWidth={3} /> : null}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, opacity: status === 'locked' ? 0.6 : 1 }}>{t.title}</div>
                    <div className="small muted">{t.objective}</div>
                    <div className="row wrap small" style={{ marginTop: 4 }}>
                      {t.sources.map((s, j) => (
                        <button
                          key={j}
                          className="cite-chip"
                          onClick={() => focusSource(classId, { sourceId: s.sourceId, section: s.section })}
                          title={bundle.sources.find((x) => x.id === s.sourceId)?.title}
                        >
                          ↗ {s.section || 'source'}
                        </button>
                      ))}
                      <span className="checks">
                        {CHECK_KINDS.map((k) => (
                          <span key={k} className={`check-pill ${p?.checks[k].passed ? 'ok' : ''}`}>
                            {k}
                          </span>
                        ))}
                      </span>
                      {status === 'mastered' && p?.nextReviewAt && <span className="small muted">review {dueLabel(p.nextReviewAt)}</span>}
                    </div>
                  </div>
                  <div>
                    {status === 'mastered' ? (
                      <button className="btn sm" disabled={starting !== null} onClick={() => start(t, 'review')}>
                        Review
                      </button>
                    ) : status !== 'locked' ? (
                      <button className="btn sm" disabled={starting !== null} onClick={() => start(t, 'learn')} data-testid="topic-study">
                        {starting === t.id + 'learn' ? <span className="spinner" /> : null} {status === 'in-progress' ? 'Continue' : 'Study'}
                      </button>
                    ) : (
                      <span className="small muted" title={`Needs: ${t.prerequisites.map((pid) => topics.find((x) => x.id === pid)?.title ?? pid).join(', ')}`}>
                        Locked
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </section>
        ))}

        {c.assumptions.length > 0 && (
          <div className="card soft small" style={{ marginTop: 12 }}>
            <b>Assumptions the plan makes:</b> {c.assumptions.join(' · ')}
            {c.cadence && (
              <div>
                <b>Cadence:</b> {c.cadence}
              </div>
            )}
          </div>
        )}

        {!pending && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-title">
              <Icon name="refresh" /> Adjust the plan
            </div>
            <p className="small muted" style={{ marginTop: -4 }}>
              The plan adapts to evidence. Ask for a revision any time; you approve the result.
            </p>
            <div className="row">
              <input className="input" placeholder="e.g. My schedule changed to 1 hour a week. Or: I want to go deeper on proofs." value={reviseReason} onChange={(e) => setReviseReason(e.target.value)} />
              <button className="btn" disabled={revising} onClick={revise} data-testid="revise-plan">
                {revising ? <span className="spinner" /> : null} Propose update
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
