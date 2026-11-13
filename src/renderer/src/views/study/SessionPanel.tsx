import { useEffect, useState, type JSX } from 'react'
import type { CheckKind, Phase, Session } from '@shared/types'
import { DEFAULT_STUDY_DEPTH, PHASE_LABEL, sessionChecks, sessionPhases } from '@shared/depth'
import { findTopic } from '@shared/curriculum'
import { api, errorMessage } from '../../lib/api'
import { useApp } from '../../state/app'
import { Icon } from '../../components/Icon'
import { RichText } from '../../components/RichText'
import { useStudy } from './context'
import { clearSessionDrafts, hideCheckDraft, savedDraft, setCheckDraft } from './drafts'
import { AnswerEditor, AnswerView } from './Answer'
import { shortcutLabel } from '../../lib/shortcuts'

/** A lesson's steps at the study depth in Settings, and where the lesson is in them ("Explain · 3 of 6"). */
export function useLessonSteps(session: Session): { phases: Phase[]; index: number; where: string } {
  const depth = useApp().settings?.studyDepth ?? DEFAULT_STUDY_DEPTH
  const phases = sessionPhases(session, depth)
  const index = Math.max(0, phases.indexOf(session.phase))
  return { phases, index, where: session.endedAt ? 'Complete' : `${PHASE_LABEL[session.phase]} · ${index + 1} of ${phases.length}` }
}
const CHECK_HELP: Record<CheckKind, string> = {
  explain: 'From memory, in your own words. No peeking.',
  apply: 'Use the idea on a new case.',
  distinguish: 'How it differs from nearby ideas.'
}

interface Props {
  session: Session
  onOpenReading: (sourceId: string, section: string) => void
  /** The lesson was wrapped up or ended early: show the plan. */
  onDone: () => void
  /** Leave a finished lesson (it stops being the class's open lesson). */
  onClose: () => void
  /** Leave out the title, when the surrounding box already shows it. */
  bare?: boolean
}

/** The session loop: brief → read → explain → apply → distinguish → wrap (fewer checks at a lighter study depth). */
export function SessionPanel({ session, onOpenReading, onDone, onClose, bare = false }: Props): JSX.Element {
  const { run } = useApp()
  const study = useStudy()
  const topic = findTopic(study.bundle.curriculum, session.topicId)
  const [busy, setBusy] = useState<string | null>(null)
  const { phases: ORDER, index: idx } = useLessonSteps(session)

  async function go(phase: Phase) {
    setBusy(`phase:${phase}`)
    const out = await run(() => api.sessions.setPhase(study.classId, session.id, phase))
    // Stay locked until the live session reflects the new phase (avoids double-advancing).
    if (!out || out.phase === session.phase) setBusy(null)
  }

  useEffect(() => {
    setBusy(null)
  }, [session.phase])

  // A lesson that has ended has no answers left to finish.
  useEffect(() => {
    if (session.endedAt) clearSessionDrafts(session.id)
  }, [session.id, session.endedAt])

  const next = ORDER[idx + 1]
  return (
    <div className="stack" data-testid="session-panel">
      {!bare && (
        <div>
          <div className="small muted">{session.type === 'review' ? 'Review session' : 'Study session'}</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{topic?.title ?? 'Topic'}</div>
        </div>
      )}
      <div className="phase-steps" role="group" aria-label="Lesson steps">
        {ORDER.map((p, i) => (
          <button
            key={p}
            aria-current={p === session.phase ? 'step' : undefined}
            className={`phase-step ${p === session.phase ? 'active' : i < idx ? 'done' : ''}`}
            disabled={busy !== null || Boolean(session.endedAt) || (p === 'wrap' && !session.attempts.length)}
            onClick={() => p !== session.phase && void go(p)}
            data-testid={`phase-${p}`}
          >
            {i < idx ? '✓ ' : ''}
            {PHASE_LABEL[p]}
          </button>
        ))}
      </div>

      {session.endedAt ? (
        <div className="card soft">
          <div className="card-title">
            <Icon name="check" /> Session complete
          </div>
          {session.wrap?.summary && <RichText text={session.wrap.summary} className="small" />}
          <button className="btn" onClick={onClose} data-testid="close-finished">
            Back to the plan
          </button>
        </div>
      ) : session.phase === 'brief' || session.phase === 'read' ? (
        <BriefCard session={session} onOpenReading={onOpenReading} />
      ) : session.phase === 'wrap' ? (
        <WrapCard session={session} onDone={onDone} />
      ) : (
        <CheckCard key={session.phase} session={session} kind={session.phase as CheckKind} onOpenReading={onOpenReading} />
      )}

      {!session.endedAt && next && session.phase !== 'wrap' && (
        <div className="row">
          <button className="btn primary" disabled={busy !== null || (next === 'wrap' && !session.attempts.length)} onClick={() => go(next)} data-testid="phase-next">
            {busy === `phase:${next}` ? <span className="spinner" /> : null}
            {session.phase === 'brief' ? 'Start reading' : session.phase === 'read' ? "I'm ready to explain" : next === 'wrap' ? 'Wrap up' : `Next: ${PHASE_LABEL[next]}`}
            <Icon name="arrow" size={14} />
          </button>
          <span className="spacer" />
          <button
            className="btn ghost sm"
            onClick={async () => {
              if (!window.confirm('End this session now? Checks you passed are kept.')) return
              const ended = await run(async () => {
                await api.sessions.abandon(study.classId, session.id)
                return true
              })
              if (!ended) return
              clearSessionDrafts(session.id)
              onDone()
            }}
          >
            End session
          </button>
        </div>
      )}
    </div>
  )
}

function BriefCard({ session, onOpenReading }: { session: Session; onOpenReading: (sourceId: string, section: string) => void }): JSX.Element {
  const study = useStudy()
  const b = session.brief
  if (!b) return <div className="muted small">Preparing your brief…</div>
  return (
    <div className="card" data-testid="brief">
      <div className="small muted">Today's win</div>
      <RichText text={b.win} className="brief-win" />
      <RichText text={b.whyItMatters} className="small brief-why" />
      <div className="label" style={{ marginBottom: 6 }}>
        Read
      </div>
      <div className="stack" style={{ gap: 6, marginBottom: 12 }}>
        {b.readings.map((r, i) => (
          <button key={i} className="list-item" onClick={() => onOpenReading(r.sourceId, r.section)} data-testid="brief-reading">
            <Icon name="book" size={15} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>
                {study.sourceTitle(r.sourceId) ?? 'Source'} · {r.section}
              </div>
              {r.note && <RichText text={r.note} className="small muted" />}
            </div>
            <Icon name="arrow" size={14} />
          </button>
        ))}
      </div>
      <div className="label" style={{ marginBottom: 6 }}>
        Read with these questions in mind
      </div>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {b.questions.map((q, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            <RichText text={q} inline />
          </li>
        ))}
      </ol>
      {session.phase === 'read' && (
        <p className="hint" style={{ marginBottom: 0 }}>
          Stuck? Select any passage and press Side chat. You can always ask for more help, one step at a time.
        </p>
      )}
    </div>
  )
}

function CheckCard({ session, kind, onOpenReading }: { session: Session; kind: CheckKind; onOpenReading: (sourceId: string, section: string) => void }): JSX.Element {
  const { toast } = useApp()
  const study = useStudy()
  // An answer started earlier (before another step, a closed dock, another class) is still here.
  const [draft, setDraft] = useState(() => savedDraft(session.id, kind))
  const [busy, setBusy] = useState(false)
  // Every tutor in the class sees what is being written here, while it is on screen.
  useEffect(() => setCheckDraft(session.id, kind, draft), [session.id, kind, draft])
  useEffect(() => () => hideCheckDraft(session.id, kind), [session.id, kind])
  const prompt = session.prompts[kind]
  const attempts = session.attempts.filter((a) => a.kind === kind)
  const last = attempts[attempts.length - 1]
  const passed = attempts.some((a) => a.verdict?.result === 'pass')
  // Explain is from memory: its readings show only once a first try sends you back to them.
  const readings = kind !== 'explain' || attempts.length > 0 ? (session.brief?.readings ?? []) : []

  async function submit(answer: string) {
    if (busy || !answer.trim()) return
    setBusy(true)
    try {
      const next = await api.sessions.submitCheck(study.classId, session.id, kind, answer)
      // Not passed yet: the answer stays, to revise or add to; the judge sees the earlier tries.
      if (next.attempts.at(-1)?.verdict?.result === 'pass') setDraft('')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!prompt) return <div className="muted small">Preparing the check…</div>
  return (
    <div className="stack">
      <div className="card">
        <div className="row small muted" style={{ marginBottom: 4 }}>
          <span className="badge">{kind}</span> {CHECK_HELP[kind]}
          {passed && <span className="badge green">passed</span>}
        </div>
        <RichText text={prompt} testId="check-prompt" />
        {readings.length > 0 && (
          <div className="row wrap small muted" style={{ marginTop: 10, gap: 6 }} data-testid="check-readings">
            Re-read:
            {readings.map((r, i) => (
              <button key={i} className="cite-chip" onClick={() => onOpenReading(r.sourceId, r.section)} title={study.sourceTitle(r.sourceId)} data-testid="check-reading">
                ↗ {r.section || study.sourceTitle(r.sourceId) || 'source'}
              </button>
            ))}
          </div>
        )}
      </div>
      {attempts.map((a) => (
        <div key={a.id} className="stack" style={{ gap: 6 }}>
          <AnswerView answer={a.answer} />
          {a.verdict && (
            <div className={`verdict ${a.verdict.result}`} data-testid="verdict">
              <div className="row" style={{ marginBottom: 4 }}>
                <b>{a.verdict.result === 'pass' ? 'Pass' : a.verdict.result === 'partial' ? 'Almost' : 'Not yet'}</b>
              </div>
              <RichText text={a.verdict.feedback} />
              {a.verdict.misconceptions.length > 0 && (
                <div className="small" style={{ marginTop: 6 }}>
                  Watch out: <RichText text={a.verdict.misconceptions.join('; ')} inline />
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {(!last || last.verdict?.result !== 'pass') && (
        <AnswerEditor
          initial={draft}
          codeLanguage={session.codeChecks?.[kind]}
          placeholder={last ? 'Try again, after re-reading the passage it pointed you to. Your earlier tries count…' : 'Your answer…'}
          onDraft={setDraft}
          onSubmit={(answer) => void submit(answer)}
        >
          {({ empty, send }) => (
            <>
              <button className="btn primary" disabled={busy || empty} onClick={send} title={`Check my answer (${shortcutLabel('checkAnswer')})`} data-testid="check-submit">
                {busy ? <span className="spinner" /> : <Icon name="check" />} Check my answer
              </button>
              <span className="hint">{shortcutLabel('checkAnswer')} to check. "I don't know" is a fine answer.</span>
            </>
          )}
        </AnswerEditor>
      )}
    </div>
  )
}

function WrapCard({ session, onDone }: { session: Session; onDone: () => void }): JSX.Element {
  const { run, settings } = useApp()
  const study = useStudy()
  const w = session.wrap
  const [records, setRecords] = useState<Set<number>>(() => new Set(w?.records.map((_, i) => i)))
  const [terms, setTerms] = useState<Set<number>>(() => new Set(w?.terms.map((_, i) => i)))
  const [busy, setBusy] = useState(false)
  // Only when the wrap-up itself arrives or changes: every reload of the class hands over a new
  // object, and resetting on that would tick again what the learner just unticked.
  useEffect(() => {
    setRecords(new Set(w?.records.map((_, i) => i)))
    setTerms(new Set(w?.terms.map((_, i) => i)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, w?.records.length, w?.terms.length])
  if (!w) return <div className="muted small">Wrapping up…</div>
  const toggle = (set: Set<number>, i: number) => {
    const n = new Set(set)
    if (n.has(i)) n.delete(i)
    else n.add(i)
    return n
  }
  const checks = sessionChecks(session, settings?.studyDepth ?? DEFAULT_STUDY_DEPTH)
  const passedKinds = checks.filter((k) => session.attempts.some((a) => a.kind === k && a.verdict?.result === 'pass'))
  return (
    <div className="stack" data-testid="wrap">
      <div className="card">
        <RichText text={w.summary} />
        <div className="row small">
          {checks.map((k) => (
            <span key={k} className={`check-pill ${passedKinds.includes(k) ? 'ok' : ''}`}>
              {k}
            </span>
          ))}
        </div>
      </div>
      {w.records.length > 0 && (
        <div className="card">
          <div className="card-title">Learning records</div>
          <p className="small muted" style={{ marginTop: -6 }}>
            Decision-grade evidence of what you now know. Keep the ones that are true.
          </p>
          {w.records.map((r, i) => (
            <label key={i} className="row" style={{ alignItems: 'flex-start', marginBottom: 8 }}>
              <input type="checkbox" checked={records.has(i)} onChange={() => setRecords((s) => toggle(s, i))} style={{ marginTop: 4 }} />
              <span>
                <b>
                  <RichText text={r.title} inline />
                </b>
                <br />
                <RichText text={r.body} inline className="small" />
              </span>
            </label>
          ))}
        </div>
      )}
      {w.terms.length > 0 && (
        <div className="card">
          <div className="card-title">Earned glossary terms</div>
          {w.terms.map((t, i) => (
            <label key={i} className="row" style={{ alignItems: 'flex-start', marginBottom: 8 }}>
              <input type="checkbox" checked={terms.has(i)} onChange={() => setTerms((s) => toggle(s, i))} style={{ marginTop: 4 }} />
              <span>
                <b>{t.term}</b>: <RichText text={t.definition} inline className="small" />
              </span>
            </label>
          ))}
        </div>
      )}
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          const out = await run(() => api.sessions.finish(study.classId, session.id, [...records], [...terms]), 'Session saved.')
          setBusy(false)
          if (out) onDone()
        }}
        data-testid="finish-session"
      >
        {busy ? <span className="spinner" /> : <Icon name="check" />} Finish session
      </button>
    </div>
  )
}
