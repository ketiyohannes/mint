import type { JSX } from 'react'
import type { ClassBundle, Session } from '@shared/types'
import { findTopic } from '@shared/curriculum'
import { Icon } from '../../components/Icon'
import { RichText } from '../../components/RichText'
import { SessionPanel } from './SessionPanel'

interface Props {
  bundle: ClassBundle
  /** The lesson of the open chat, if it is a lesson chat (ended lessons included, to show their summary). */
  session: Session | undefined
  onOpenReading: (sourceId: string, section: string) => void
  /** Open a lesson's chat (its study box then shows here). */
  onResume: (sessionId: string) => void
  onStartNext: () => void
  /** Leave the study box for the plan. */
  onDone: () => void
}

/**
 * The Study tab: the lesson loop (brief, read, explain, apply, distinguish,
 * wrap up) for the lesson chat that is open, so the chat stays a conversation.
 */
export function StudyTab({ bundle, session, onOpenReading, onResume, onStartNext, onDone }: Props): JSX.Element {
  if (session) {
    return (
      <div className="panel-pad" data-testid="study">
        <SessionPanel session={session} onOpenReading={onOpenReading} onDone={onDone} />
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
                <div className="small muted">{s.type === 'review' ? 'Review' : 'Lesson'} · {s.phase === 'wrap' ? 'wrapping up' : s.phase}</div>
              </div>
              <Icon name="arrow" size={14} />
            </button>
          ))}
        </div>
      )}
      {next && (
        <div>
          <button className="btn primary" onClick={onStartNext} data-testid="study-start">
            <Icon name="play" size={11} /> Start the next lesson: <RichText text={next.title} inline />
          </button>
        </div>
      )}
      {!open.length && !next && <p className="hint">Pick a topic in the Lessons tab to start.</p>}
    </div>
  )
}
