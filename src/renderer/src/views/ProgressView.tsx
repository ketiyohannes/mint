import { useState, type JSX } from 'react'
import { CHECK_KINDS, RUNG_LABELS, type ClassBundle, type LearningRecord, type Rung } from '@shared/types'
import { allTopics } from '@shared/curriculum'
import { useApp } from '../state/app'
import { api, dueLabel, timeAgo } from '../lib/api'
import { Icon } from '../components/Icon'

const LEVELS = ['Guided', 'Supported', 'Coached', 'Independent']
const LEVEL_TEXT = [
  'The tutor starts with a hint. A full explanation is always one click away.',
  'The tutor starts with a guiding question. You do most of the thinking.',
  'The tutor starts by pointing you to the passage. You work it out from the source.',
  'The tutor only points you to the passage, and you rarely need more. You are learning on your own.'
]
const KIND_BADGE: Record<LearningRecord['kind'], string> = { understanding: 'green', 'prior-knowledge': 'blue', misconception: 'amber', 'mission-shift': '' }

export function ProgressView({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const ind = bundle.independence
  const topics = allTopics(bundle.curriculum)
  const rungCounts = ([1, 2, 3, 4] as Rung[]).map((r) => bundle.helpEvents.filter((e) => e.rung === r).length)
  const maxCount = Math.max(1, ...rungCounts)
  const finished = bundle.sessions.filter((s) => s.endedAt).sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))

  return (
    <div className="page">
      <div className="page-inner">
        <div className="grid-2">
          <div className="card" data-testid="independence-card">
            <div className="card-title">
              <Icon name="target" /> Independence
              <span className="spacer" />
              <span className="badge green">{LEVELS[ind.level]}</span>
            </div>
            <div className="row" style={{ alignItems: 'baseline', gap: 10 }}>
              <span className="serif" style={{ fontSize: 40, fontWeight: 600 }}>
                {Math.round(ind.score * 100)}
              </span>
              <span className="muted">/ 100</span>
            </div>
            <Sparkline points={ind.history.map((h) => h.score)} />
            <p className="small" style={{ margin: '8px 0 4px' }}>
              {LEVEL_TEXT[ind.level]}
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              {ind.reason}
            </p>
          </div>
          <div className="card">
            <div className="card-title">
              <Icon name="help" /> Help you used
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {([1, 2, 3, 4] as Rung[]).map((r, i) => (
                <div key={r} className="row">
                  <span className="small" style={{ width: 120 }}>
                    {RUNG_LABELS[r]}
                  </span>
                  <div className="progress-bar" style={{ flex: 1 }}>
                    <div style={{ width: `${(rungCounts[i] / maxCount) * 100}%`, background: r === 1 ? 'var(--primary)' : r === 4 ? 'var(--accent)' : undefined }} />
                  </div>
                  <span className="small muted" style={{ width: 28, textAlign: 'right' }}>
                    {rungCounts[i]}
                  </span>
                </div>
              ))}
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Fewer explanations and more pointers over time is the goal: the more you use mint, the less you need it.
            </p>
          </div>
        </div>

        <h2 className="section-title">Mastery</h2>
        <div className="card" style={{ padding: '6px 16px' }}>
          {!topics.length && <div className="empty small">No curriculum yet.</div>}
          {topics.map((t) => {
            const p = bundle.progress[t.id]
            return (
              <div key={t.id} className="row" style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <span className={`status-dot ${p?.status ?? 'locked'}`}>{p?.status === 'mastered' ? <Icon name="check" size={11} strokeWidth={3} /> : null}</span>
                <span style={{ flex: 1 }}>{t.title}</span>
                <span className="checks">
                  {CHECK_KINDS.map((k) => (
                    <span key={k} className={`check-pill ${p?.checks[k].passed ? 'ok' : ''}`}>
                      {k}
                    </span>
                  ))}
                </span>
                <span className="small muted" style={{ width: 120, textAlign: 'right' }}>
                  {p?.status === 'mastered' ? `review ${dueLabel(p.nextReviewAt)}` : (p?.status ?? 'locked')}
                </span>
              </div>
            )
          })}
        </div>

        <h2 className="section-title">Learning records</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Like decision records for your mind: what you have shown you know, prior knowledge, corrected misconceptions. They decide what you are taught next.
        </p>
        <Records bundle={bundle} />

        {finished.length > 0 && (
          <>
            <h2 className="section-title">Sessions</h2>
            <div className="stack" style={{ gap: 6 }}>
              {finished.slice(0, 20).map((s) => {
                const t = topics.find((x) => x.id === s.topicId)
                const passed = CHECK_KINDS.filter((k) => s.attempts.some((a) => a.kind === k && a.verdict?.result === 'pass'))
                return (
                  <div key={s.id} className="row small" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <span className="badge">{s.type}</span>
                    <span style={{ flex: 1 }}>{t?.title ?? s.topicId}</span>
                    <span className="muted">{passed.length ? `passed ${passed.join(', ')}` : 'no passes'}</span>
                    <span className="muted" style={{ width: 90, textAlign: 'right' }}>
                      {timeAgo(s.endedAt)}
                    </span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Records({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const { run } = useApp()
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const records = [...bundle.records].sort((a, b) => b.number - a.number)
  if (!records.length) return <div className="card empty small">No records yet. They appear after the diagnostic and when you finish sessions.</div>
  return (
    <div className="card" style={{ padding: '0 18px' }} data-testid="records">
      {records.map((r) => {
        const sup = r.supersededBy ? bundle.records.find((x) => x.id === r.supersededBy) : undefined
        return (
          <div key={r.id} className={`record ${sup ? 'superseded' : ''}`}>
            <span className="record-num">LR-{String(r.number).padStart(4, '0')}</span>
            <div>
              <div className="row">
                <b>{r.title}</b>
                <span className={`badge ${KIND_BADGE[r.kind]}`}>{r.kind}</span>
                <span className="spacer" />
                {!sup && editing !== r.id && (
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      setEditing(r.id)
                      setTitle(r.title)
                      setBody(r.body)
                    }}
                  >
                    Supersede
                  </button>
                )}
              </div>
              <div className="small">{r.body}</div>
              {r.evidence && <div className="small muted">Evidence: {r.evidence}</div>}
              {sup && <div className="small muted">Superseded by LR-{String(sup.number).padStart(4, '0')}</div>}
              {editing === r.id && (
                <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                  <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
                  <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} />
                  <div className="row">
                    <button
                      className="btn primary sm"
                      onClick={async () => {
                        await run(() => api.records.supersede(bundle.meta.id, r.id, title, body), 'Record superseded.')
                        setEditing(null)
                      }}
                    >
                      Save new record
                    </button>
                    <button className="btn ghost sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Sparkline({ points }: { points: number[] }): JSX.Element {
  if (points.length < 2) return <div className="small muted" style={{ height: 64, display: 'grid', placeItems: 'center' }}>Your trend appears as you study.</div>
  const w = 300
  const h = 64
  const xs = points.map((_, i) => (i / (points.length - 1)) * w)
  const ys = points.map((p) => h - 4 - p * (h - 8))
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Independence over time">
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="var(--primary-soft)" />
      <path d={d} fill="none" stroke="var(--primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
