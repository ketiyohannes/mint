import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { Session } from '@shared/types'
import { findTopic } from '@shared/curriculum'
import { Icon } from '../../components/Icon'
import { RichText } from '../../components/RichText'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { IS_MAC } from '../../components/Sidebar'
import { useStudy } from './context'
import { useHasDraft } from './drafts'
import { ORDER, PHASE_LABEL, SessionPanel } from './SessionPanel'

const HEIGHT_KEY = 'mint.lessonDock.height'
const DEFAULT_HEIGHT = 380
const MIN_HEIGHT = 140
/** Dragging the handle this far above the smallest height folds the dock. */
const FOLD_PULL = 60
/** Kept clear under the dock (matches the max-height in styles.css). */
const ROOM_BELOW = 190
export const DOCK_SHORTCUT = IS_MAC ? '⌘L' : 'Ctrl+L'

interface Props {
  session: Session
  folded: boolean
  onFold: (folded: boolean) => void
  /** Take the lesson off the chats (it stays in progress unless it is finished). */
  onClose: () => void
  /** Show lessons in the Study tab instead (the Settings choice). */
  onMoveToTab: () => void
  onOpenReading: (sourceId: string, section: string) => void
  onDone: () => void
}

/**
 * The open lesson, docked over the top of the chat. It floats: the chat
 * scrolls behind it, it folds to one line, and its handle sets its height. It
 * lives outside the chat view, so it stays put (with a half-written answer)
 * when another chat opens.
 */
export function LessonDock({ session, folded, onFold, onClose, onMoveToTab, onOpenReading, onDone }: Props): JSX.Element {
  const study = useStudy()
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(() => {
    const stored = Number(localStorage.getItem(HEIGHT_KEY))
    return stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT
  })
  const hasDraft = useHasDraft(session.id)
  const topic = findTopic(study.bundle.curriculum, session.topicId)
  const step = ORDER.indexOf(session.phase)
  const where = session.endedAt ? 'Complete' : `${PHASE_LABEL[session.phase]} · ${step + 1} of ${ORDER.length}`
  const progress = session.endedAt ? 1 : step / ORDER.length

  // The chat pane pads its messages by the dock's height (--dock-h), so the
  // first message can scroll out from under it. When that padding changes,
  // the messages on screen hold still instead of jumping.
  useLayoutEffect(() => {
    const el = ref.current
    const pane = el?.parentElement
    if (!el || !pane) return
    let current = 0
    const shift = (delta: number) => {
      const body = pane.querySelector<HTMLElement>('.chat-body')
      if (body) body.scrollTop += delta
    }
    const sync = () => {
      const h = el.offsetHeight
      if (h === current) return
      pane.style.setProperty('--dock-h', `${h}px`)
      shift(h - current)
      current = h
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => {
      observer.disconnect()
      pane.style.removeProperty('--dock-h')
      shift(-current)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'l' || !(IS_MAC ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return
      e.preventDefault()
      onFold(!folded)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [folded, onFold])

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const grip = e.currentTarget
    const dock = ref.current!
    const top = dock.getBoundingClientRect().top
    // Leave the composer and a few lines of chat in view.
    const limit = Math.max(MIN_HEIGHT, dock.parentElement!.getBoundingClientRect().bottom - top - ROOM_BELOW)
    let next = Math.min(height, limit)
    let fold = false
    grip.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing', 'resizing-v')
    const move = (ev: PointerEvent) => {
      const want = ev.clientY - top
      fold = want < MIN_HEIGHT - FOLD_PULL
      next = Math.round(Math.min(limit, Math.max(MIN_HEIGHT, want)))
      setHeight(next)
    }
    const end = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', end)
      grip.removeEventListener('pointercancel', end)
      document.body.classList.remove('resizing', 'resizing-v')
      if (fold) onFold(true)
      else localStorage.setItem(HEIGHT_KEY, String(next))
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  }

  return (
    <div
      ref={ref}
      className={`lesson-dock ${folded ? 'folded' : ''}`}
      style={{ ['--dock-max' as string]: `${height}px` }}
      role="region"
      aria-label="Open lesson"
      data-testid="lesson-dock"
    >
      <div
        className="lesson-dock-bar"
        onClick={(e) => {
          if (folded && !(e.target as HTMLElement).closest('button')) onFold(false)
        }}
      >
        <Icon name="study" size={15} />
        <span className="lesson-dock-kind">{session.type === 'review' ? 'Review' : 'Lesson'}</span>
        <RichText text={topic?.title ?? 'Lesson'} inline className="lesson-dock-title" />
        <span className="spacer" />
        {folded && hasDraft && <span className="lesson-dock-draft">draft kept</span>}
        <span className="lesson-dock-where" data-testid="lesson-dock-where">
          {where}
        </span>
        <button className="icon-btn" onClick={onMoveToTab} title="Show lessons in the Study tab instead" aria-label="Show lessons in the Study tab" data-testid="lesson-dock-to-tab">
          <Icon name="sidebar" size={14} />
        </button>
        <button
          className="icon-btn lesson-dock-fold"
          onClick={() => onFold(!folded)}
          title={`${folded ? 'Unfold' : 'Fold'} (${DOCK_SHORTCUT})`}
          aria-label={folded ? 'Unfold the lesson' : 'Fold the lesson'}
          aria-expanded={!folded}
          data-testid="lesson-dock-fold"
        >
          <Icon name="caret" size={14} />
        </button>
        <button
          className="icon-btn"
          onClick={onClose}
          title={session.endedAt ? 'Close' : 'Close (the lesson stays in progress)'}
          aria-label="Close the lesson"
          data-testid="lesson-dock-close"
        >
          <Icon name="x" size={13} />
        </button>
        {folded && (
          <div className="lesson-dock-progress" aria-hidden="true">
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
      {/* Stays mounted while folded, so a half-written answer survives. */}
      <div className="lesson-dock-body" data-testid="lesson-dock-body">
        <ErrorBoundary label="the lesson">
          <SessionPanel
            session={session}
            onOpenReading={onOpenReading}
            onDone={onDone}
            onClose={() => {
              onClose()
              onDone()
            }}
            bare
          />
        </ErrorBoundary>
      </div>
      {!folded && (
        <div
          className="lesson-dock-grip"
          onPointerDown={startResize}
          onDoubleClick={() => onFold(true)}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the lesson"
          title="Drag to resize, double-click to fold"
          data-testid="lesson-dock-grip"
        >
          <i />
        </div>
      )}
    </div>
  )
}
