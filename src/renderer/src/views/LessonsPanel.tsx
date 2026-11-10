import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { CHECK_KINDS, type ClassBundle, type GlossaryTerm, type Topic } from '@shared/types'
import { allTopics } from '@shared/curriculum'
import { useApp } from '../state/app'
import { api, dueLabel } from '../lib/api'
import { Icon } from '../components/Icon'
import { RichText } from '../components/RichText'
import { Proposals } from '../components/Proposals'

const LEVELS = ['Guided', 'Supported', 'Coached', 'Independent']

interface Props {
  bundle: ClassBundle
  /** Start (or review) a topic as a lesson, in the chat that is showing. */
  onStart: (topicId: string) => void
  /** Open the chat of an open lesson. */
  onResume: (sessionId: string) => void
  openSource: (sourceId: string, section?: string) => void
}

/** Your lessons: the curriculum as a checklist, what's next and due, and a one-line way to change it. */
export function LessonsPanel({ bundle, onStart, onResume, openSource }: Props): JSX.Element {
  const { run, jobs } = useApp()
  const classId = bundle.meta.id
  const c = bundle.curriculum
  const [reason, setReason] = useState('')
  const [planning, setPlanning] = useState(false)
  const topics = allTopics(c)
  const openSession = [...bundle.sessions].reverse().find((s) => !s.endedAt)
  const mastered = topics.filter((t) => bundle.progress[t.id]?.status === 'mastered').length
  const busyPlanning = planning || jobs.some((j) => j.classId === classId && /curriculum/i.test(j.label))
  const legacyPending = bundle.curriculumProposals.find((p) => p.status === 'pending')

  // Opening the tab brings what is next into view when it is further down the plan (with a lesson
  // under way, Resume at the top is the way on). Scrolls the tab only: scrollIntoView would try the app shell too.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const next = rootRef.current?.querySelector<HTMLElement>('.plan-topic.next')
    const scroller = rootRef.current?.closest<HTMLElement>('.panel-page')
    if (!next || !scroller || openSession) return
    const row = next.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    if (row.bottom > view.bottom) scroller.scrollTop += row.top - view.top - (view.height - row.height) / 2
  }, [])

  const start = (topic: Topic) => {
    const open = bundle.sessions.find((s) => !s.endedAt && s.topicId === topic.id)
    if (open) onResume(open.id)
    else onStart(topic.id)
  }

  async function plan(why?: string) {
    setPlanning(true)
    const ok = await run(
      async () => {
        await api.intake.autoPlan(classId, why)
        return true
      },
      c ? 'Plan updated.' : 'Plan ready.'
    )
    setPlanning(false)
    if (ok) setReason('')
  }

  if (!c) {
    return (
      <div className="panel-pad stack">
        {!bundle.sources.length ? (
          <Proposals bundle={bundle} />
        ) : busyPlanning ? (
          <div className="status-line">
            <span className="spinner tiny" /> Planning a curriculum from your materials…
          </div>
        ) : (
          <div className="stack">
            <p className="muted">No plan yet. Tell the tutor what you want in the chat and it plans your lessons, each tied to the pages that teach it.</p>
            <div>
              <button className="btn primary" onClick={() => void plan()} data-testid="plan-curriculum">
                <Icon name="sparkle" size={14} /> Plan curriculum
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="panel-pad stack plan" ref={rootRef} data-testid="plan">
      <div className="plan-stats">
        <span title={bundle.independence.reason} data-testid="independence-badge">
          <Icon name="target" size={13} /> {LEVELS[bundle.independence.level]}
        </span>
        <span>
          {mastered}/{topics.length} mastered
        </span>
        {bundle.reviewsDue.length > 0 && (
          <span className="warn">
            {bundle.reviewsDue.length} review{bundle.reviewsDue.length > 1 ? 's' : ''} due
          </span>
        )}
      </div>

      {openSession && (
        <button className="plan-resume" onClick={() => onResume(openSession.id)} data-testid="resume-session">
          <Icon name="book" size={14} />
          <span>
            Resume: <RichText text={topics.find((t) => t.id === openSession.topicId)?.title ?? 'lesson'} inline />
          </span>
          <span className="spacer" />
          <Icon name="arrow" size={13} />
        </button>
      )}

      {legacyPending && (
        <div className="callout">
          <div>A proposed plan is waiting.</div>
          <div className="row">
            <button className="btn sm primary" onClick={() => void run(() => api.intake.resolveCurriculum(classId, legacyPending.id, true))}>
              Use it
            </button>
            <button className="btn sm ghost" onClick={() => void run(() => api.intake.resolveCurriculum(classId, legacyPending.id, false))}>
              Discard
            </button>
          </div>
        </div>
      )}

      {c.summary && <RichText text={c.summary} className="muted small" />}

      {c.milestones.map((m, i) => (
        <section key={m.id} className="plan-milestone">
          <div className="plan-milestone-title">
            <span className="muted">{String(i + 1).padStart(2, '0')}</span> <RichText text={m.title} inline />
            <span className="small muted" style={{ marginLeft: 8, fontWeight: 400 }} title="Lessons mastered in this part" data-testid="milestone-progress">
              {m.topics.filter((t) => bundle.progress[t.id]?.status === 'mastered').length}/{m.topics.length}
            </span>
          </div>
          {m.topics.map((t) => {
            const p = bundle.progress[t.id]
            const status = p?.status ?? 'locked'
            const due = bundle.reviewsDue.includes(t.id)
            const passed = CHECK_KINDS.filter((k) => p?.checks[k].passed).length
            const isNext = t.id === bundle.nextTopicId
            return (
              <div key={t.id} className={`plan-topic ${status} ${isNext ? 'next' : ''}`} data-testid="topic-row">
                <span className={`status-dot ${status}`} style={{ ['--pct' as string]: `${(passed / 3) * 100}%` }} title={status}>
                  {status === 'mastered' ? <Icon name="check" size={10} strokeWidth={3} /> : null}
                </span>
                <div className="plan-topic-body">
                  <RichText text={t.title} className="plan-topic-title" />
                  <RichText text={t.objective} className="small muted" />
                  <div className="plan-topic-meta">
                    {t.sources.map((s, j) => (
                      <button key={j} className="cite-chip" onClick={() => openSource(s.sourceId, s.section)} title={bundle.sources.find((x) => x.id === s.sourceId)?.title}>
                        ↗ {s.section || 'source'}
                      </button>
                    ))}
                    {t.sources.length === 0 && <GapBadge bundle={bundle} topic={t} />}
                    {status === 'mastered' && p?.nextReviewAt && <span className="small muted">review {dueLabel(p.nextReviewAt)}</span>}
                  </div>
                </div>
                <div className="plan-topic-action">
                  {status === 'locked' ? (
                    <span className="small muted" title={`Needs: ${t.prerequisites.map((pid) => topics.find((x) => x.id === pid)?.title ?? pid).join(', ')}`}>
                      locked
                    </span>
                  ) : status === 'mastered' ? (
                    <button className={`btn sm ${due ? 'primary' : ''}`} onClick={() => start(t)} data-testid={due ? 'start-review' : undefined}>
                      Review
                    </button>
                  ) : (
                    <button className={`btn sm ${isNext ? 'primary' : ''}`} onClick={() => start(t)} data-testid={isNext ? 'start-session' : 'topic-study'}>
                      {bundle.sessions.some((s) => !s.endedAt && s.topicId === t.id) ? 'Resume' : status === 'in-progress' ? 'Continue' : 'Start'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </section>
      ))}

      <form
        className="plan-adjust"
        onSubmit={(e) => {
          e.preventDefault()
          void plan(reason.trim() || 'Revise the plan based on my recent evidence and any new materials.')
        }}
      >
        <input
          className="input sm"
          placeholder="Change the plan… e.g. skip the history, more practice on proofs"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="revise-input"
        />
        <button className="btn sm" disabled={busyPlanning} data-testid="revise-plan">
          {busyPlanning ? <span className="spinner tiny" /> : <Icon name="refresh" size={13} />} {reason.trim() ? 'Apply' : 'Refresh'}
        </button>
      </form>

      {bundle.glossary.length > 0 && <Glossary terms={bundle.glossary} openSource={openSource} />}

      <Proposals bundle={bundle} compact />
    </div>
  )
}

/** The terms the learner has earned, each as they defined it. Folded until asked for. */
function Glossary({ terms, openSource }: { terms: GlossaryTerm[]; openSource: (sourceId: string, section?: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const sorted = useMemo(() => [...terms].sort((a, b) => a.term.localeCompare(b.term)), [terms])
  return (
    <section className="plan-glossary" data-testid="glossary">
      <button className="plan-glossary-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="glossary-toggle">
        <Icon name="term" size={13} /> Glossary <span className="muted">{terms.length}</span>
        <span className="spacer" />
        <Icon name="caret" size={12} />
      </button>
      {open && (
        <dl>
          {sorted.map((t) => (
            <div key={t.id} className="plan-term" data-testid="glossary-term">
              <dt>{t.term}</dt>
              <dd>
                <RichText text={t.definition} inline />
                {t.sourceRef && (
                  <button className="cite-chip" onClick={() => openSource(t.sourceRef!.sourceId, t.sourceRef!.section)} title="Where you met it" data-testid="glossary-source">
                    ↗ {t.sourceRef.section || 'source'}
                  </button>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

/**
 * A topic your materials do not cover is a research task. Early on mint finds
 * candidate sources; once you are more independent, you find one yourself.
 */
function GapBadge({ bundle, topic }: { bundle: ClassBundle; topic: Topic }): JSX.Element {
  const { run } = useApp()
  const [busy, setBusy] = useState(false)
  if (bundle.independence.level >= 2) {
    return (
      <span className="badge amber" title="Your materials do not cover this. Finding a good source is part of the skill: search in the Browser tab and add it." data-testid="gap">
        gap: find a source
      </span>
    )
  }
  return (
    <button
      className="badge amber"
      // A badge that is a button: without the browser's own button border.
      style={{ border: 0, cursor: busy ? 'default' : 'pointer' }}
      disabled={busy}
      title="Your materials do not cover this. mint can suggest trusted sources for you to approve."
      onClick={async () => {
        setBusy(true)
        await run(() => api.sources.proposeTrusted(bundle.meta.id, `${topic.title}: ${topic.objective}`), 'Suggestions are at the bottom of the Lessons tab.')
        setBusy(false)
      }}
      data-testid="gap"
    >
      {busy ? <span className="spinner tiny" /> : null} gap: suggest sources
    </button>
  )
}
