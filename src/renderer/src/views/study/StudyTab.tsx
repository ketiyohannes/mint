import type { JSX } from 'react'
import type { ClassBundle, Session } from '@shared/types'
import { findTopic } from '@shared/curriculum'
import { Icon } from '../../components/Icon'
import { RichText } from '../../components/RichText'
import { SessionPanel } from './SessionPanel'

interface Props {
  bundle: ClassBundle
  /** The class's open lesson (a finished one included, to show its summary). */
  session: Session | undefined
  onOpenReading: (sourceId: string, section: string) => void
  /** Open a lesson in progress (it then shows here). */
  onResume: (sessionId: string) => void
  onStartNext: () => void
  /** The lesson was wrapped up or ended early: show the plan. */
  onDone: () => void
  /** Leave a finished lesson. */
  onClose: () => void
  /** Dock lessons over the chat instead (the Settings choice). */
  onDock?: () => void
  /** Move the lesson into a window of its own. */
  onPopOut?: () => void
}

/**
 * The Study tab: the lesson loop (brief, read, explain, apply, distinguish,
 * wrap up) of the class's open lesson, beside whichever chat is showing.
 */
export function StudyTab({ bundle, session, onOpenReading, onResume, onStartNext, onDone, onClose, onDock, onPopOut }: Props): JSX.Element {
  if (session) {
    return (
      <div className="panel-pad stack" data-testid="study">
        <div className="row">
          <span className="spacer" />
          {onPopOut && (
            <button className="btn ghost sm" onClick={onPopOut} title="Move the lesson into a window of its own" data-testid="study-popout">
              <Icon name="popOut" size={13} /> Open in a window
            </button>
          )}
          {onDock && (
            <button className="btn ghost sm" onClick={onDock} title="Dock lessons over the chat instead" data-testid="study-to-dock">
              <Icon name="expand" size={13} /> Show over the chat
            </button>
          )}
        </div>
        {/* Keyed by lesson, so an answer written in one never shows up in the next. */}
        <SessionPanel key={session.id} session={session} onOpenReading={onOpenReading} onDone={onDone} onClose={onClose} />
      </div>
    )
  }

  const open = bundle.sessions.filter((s) => !s.endedAt).reverse()
  const next = bundle.nextTopicId ? findTopic(bundle.curriculum, bundle.nextTopicId) : undefined
  return (
    <div className="panel-pad stack" data-testid="study">
      <div className="study-empty">
        <Icon name="study" size={22} />
        <p>Lessons open here: the brief, the reading, and the checks that show you know it. The chat stays free for your questions.</p>
      </div>
      {open.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="label">Open lessons</div>
          {open.map((s) => (
            <button key={s.id} className="list-item" onClick={() => onResume(s.id)} data-testid="study-resume">
              <Icon name="lesson" size={15} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <RichText text={findTopic(bundle.curriculum, s.topicId)?.title ?? 'Lesson'} inline />
                <div className="small muted">
                  {s.type === 'review' ? 'Review' : 'Lesson'} · {s.phase === 'wrap' ? 'wrapping up' : s.phase}
                </div>
              </div>
              <Icon name="arrow" size={14} />
            </button>
          ))}
        </div>
      )}
      {next && (
        <div>
          {/* A long title wraps inside the button instead of running out of the panel. */}
          <button
            className="btn primary"
            style={{ height: 'auto', minHeight: 34, maxWidth: '100%', padding: '6px 14px', whiteSpace: 'normal', textAlign: 'left' }}
            onClick={onStartNext}
            data-testid="study-start"
          >
            <Icon name="play" size={11} />
            <span>
              Start the next lesson: <RichText text={next.title} inline />
            </span>
          </button>
        </div>
      )}
      {!open.length && !next && <p className="hint">Pick a topic in the Lessons tab to start.</p>}
    </div>
  )
}
