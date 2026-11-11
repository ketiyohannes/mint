import type { JSX } from 'react'
import type { ClassBundle, Session } from '@shared/types'
import { findTopic } from '@shared/curriculum'
import { Icon } from '../../components/Icon'
import { RichText } from '../../components/RichText'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { SessionPanel, useLessonSteps } from './SessionPanel'
import { StudyTab } from './StudyTab'

interface Props {
  bundle: ClassBundle
  /** The class's open lesson (a finished one included, to show its summary). */
  session: Session | undefined
  onOpenReading: (sourceId: string, section: string) => void
  onResume: (sessionId: string) => void
  onStartNext: () => void
  onDone: () => void
  onClose: () => void
  /** Put the lesson back in the main window. */
  onDock: () => void
}

function LessonWhere({ session }: { session: Session }): JSX.Element {
  return (
    <span className="lesson-dock-where" data-testid="lesson-window-where">
      {useLessonSteps(session).where}
    </span>
  )
}

/**
 * The lesson in a window of its own: the class's open lesson, or, between
 * lessons, what can be resumed or started next. The chat stays in the main
 * window, and readings open wherever the panel is.
 */
export function LessonWindow({ bundle, session, onOpenReading, onResume, onStartNext, onDone, onClose, onDock }: Props): JSX.Element {
  const topic = session && findTopic(bundle.curriculum, session.topicId)
  return (
    <section className="lesson-window" data-testid="lesson-window">
      <div className="pane-head">
        <div className="crumbs">
          <Icon name="study" size={15} />
          <span className="lesson-dock-kind">{session?.type === 'review' ? 'Review' : 'Lesson'}</span>
          {session ? <RichText text={topic?.title ?? 'Lesson'} inline className="lesson-dock-title" /> : <span className="ellipsis">{bundle.meta.title}</span>}
        </div>
        <span className="spacer" />
        {session && <LessonWhere session={session} />}
        <button className="icon-btn" onClick={onDock} title="Put the lesson back in the main window" aria-label="Put the lesson back in the main window" data-testid="lesson-window-dock">
          <Icon name="popIn" size={15} />
        </button>
      </div>
      <div className="lesson-window-body scroll">
        <ErrorBoundary label="the lesson">
          {session ? (
            <div className="panel-pad">
              {/* Keyed by lesson, so an answer written in one never shows up in the next. */}
              <SessionPanel key={session.id} session={session} onOpenReading={onOpenReading} onDone={onDone} onClose={onClose} bare />
            </div>
          ) : (
            <StudyTab bundle={bundle} session={undefined} onOpenReading={onOpenReading} onResume={onResume} onStartNext={onStartNext} onDone={onDone} onClose={onClose} />
          )}
        </ErrorBoundary>
      </div>
    </section>
  )
}
