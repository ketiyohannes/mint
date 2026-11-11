import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { Session } from '@shared/types'
import { findTopic } from '@shared/curriculum'
import { Icon } from '../../components/Icon'
import { RichText } from '../../components/RichText'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { matchesShortcut, shortcutLabel } from '../../lib/shortcuts'
import { useStudy } from './context'
import { useHasDraft } from './drafts'
import { SessionPanel, useLessonSteps } from './SessionPanel'

const HEIGHT_KEY = 'mint.lessonDock.height'
const PLACE_KEY = 'mint.lessonDock.place'
const WIDTH_KEY = 'mint.lessonDock.width'
const DOCKED_WIDTH_KEY = 'mint.lessonDock.dockedWidth'
const DEFAULT_HEIGHT = 380
const MIN_HEIGHT = 140
/** Dragging the handle this far above the smallest height folds the dock. */
const FOLD_PULL = 60
/** Kept clear under the docked lesson (matches the max-height in styles.css). */
const ROOM_BELOW = 190
/** The docked lesson's top, and the pane head's height (styles.css). */
const DOCK_TOP = 60
const PANE_HEAD = 52
/** A floating lesson keeps this far inside the chat pane. */
const EDGE = 8
const FLOAT_WIDTH = 480
/** Kept clear on each side of the docked lesson. */
const DOCKED_MARGIN = 16
/** Narrower than this, the bar's buttons no longer fit and Close is cut off. */
const MIN_WIDTH = 400
/** Dropping the lesson this close to the top docks it again. */
const SNAP = 28
/** The pointer moves this far before a press on the bar becomes a drag. */
const DRAG_SLOP = 4
export const DOCK_SHORTCUT = shortcutLabel('foldLesson')

/** Where a floating lesson sits, in pixels from the chat pane's top left. */
interface Place {
  x: number
  y: number
  w: number
}

function readPlace(): Place | null {
  try {
    const p = JSON.parse(localStorage.getItem(PLACE_KEY) ?? 'null') as Partial<Place> | null
    return p && [p.x, p.y, p.w].every((n) => typeof n === 'number' && Number.isFinite(n)) ? (p as Place) : null
  } catch {
    return null
  }
}

/**
 * Keeps a floating lesson whole inside the pane, and below the pane head
 * (a window-drag region, which would take its clicks). Returns the same
 * object when nothing moves, so a refit does not re-render.
 */
function fit(p: Place, paneW: number, paneH: number, dockH: number): Place {
  const w = Math.round(Math.max(Math.min(MIN_WIDTH, paneW - 2 * EDGE), Math.min(p.w, paneW - 2 * EDGE)))
  const x = Math.round(Math.max(EDGE, Math.min(p.x, paneW - w - EDGE)))
  const y = Math.round(Math.max(PANE_HEAD + EDGE, Math.min(p.y, paneH - dockH - EDGE)))
  return x === p.x && y === p.y && w === p.w ? p : { x, y, w }
}

interface Props {
  session: Session
  folded: boolean
  onFold: (folded: boolean) => void
  /** Take the lesson off the chats (it stays in progress unless it is finished). */
  onClose: () => void
  /** Show lessons in the Study tab instead (the Settings choice). */
  onMoveToTab: () => void
  /** Move the lesson into a window of its own. */
  onPopOut: () => void
  onOpenReading: (sourceId: string, section: string) => void
  onDone: () => void
}

/**
 * The open lesson, docked over the top of the chat. It floats: the chat
 * scrolls behind it, it folds to one line, its bottom handle sets its height
 * and its sides set its width. Dragged by its bar, it lifts off anywhere over
 * the chat; dropped back at the top, it docks again. It lives outside the chat
 * view, so it stays put (with a half-written answer) when another chat opens.
 */
export function LessonDock({ session, folded, onFold, onClose, onMoveToTab, onPopOut, onOpenReading, onDone }: Props): JSX.Element {
  const study = useStudy()
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(() => {
    const stored = Number(localStorage.getItem(HEIGHT_KEY))
    return stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT
  })
  /** Null while docked at the top. */
  const [place, setPlace] = useState<Place | null>(readPlace)
  /** The docked lesson's width, once it has been dragged; it stays centred. */
  const [dockedWidth, setDockedWidth] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(DOCKED_WIDTH_KEY))
    return stored >= MIN_WIDTH ? stored : null
  })
  const floating = place !== null
  /** Shows where a lesson dragged to the top will dock. */
  const [snapping, setSnapping] = useState(false)
  /** Set when a press on the bar became a drag, so its click does not unfold the lesson. */
  const dragged = useRef(false)
  const hasDraft = useHasDraft(session.id)
  const topic = findTopic(study.bundle.curriculum, session.topicId)
  const { phases, index: step, where } = useLessonSteps(session)
  const progress = session.endedAt ? 1 : step / phases.length

  // The chat pane pads its messages by the docked lesson's height (--dock-h),
  // so the first message can scroll out from under it; a floating lesson
  // reserves no room. When that padding changes, the messages on screen hold
  // still instead of jumping.
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
      const h = floating ? 0 : el.offsetHeight
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
  }, [floating])

  // A floating lesson stays whole on screen: when the pane narrows, or the
  // lesson unfolds near the bottom, it moves back inside.
  useLayoutEffect(() => {
    const el = ref.current
    const pane = el?.parentElement
    if (!floating || !el || !pane) return
    const refit = () => setPlace((p) => p && fit(p, pane.clientWidth, pane.clientHeight, el.offsetHeight))
    refit()
    const observer = new ResizeObserver(refit)
    observer.observe(el)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [floating])

  useEffect(() => {
    if (place) localStorage.setItem(PLACE_KEY, JSON.stringify(place))
    else localStorage.removeItem(PLACE_KEY)
  }, [place])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, 'foldLesson')) return
      e.preventDefault()
      onFold(!folded)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [folded, onFold])

  /** Follows one pointer drag on a handle, captured so it cannot slip off. */
  const track = (handle: HTMLElement, pointerId: number, move: (ev: PointerEvent) => void, end: () => void) => {
    handle.setPointerCapture(pointerId)
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      end()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const dock = ref.current!
    const top = dock.getBoundingClientRect().top
    // Docked, leave the composer and a few lines of chat in view; floating, stay inside the pane.
    const limit = Math.max(MIN_HEIGHT, dock.parentElement!.getBoundingClientRect().bottom - top - (floating ? EDGE : ROOM_BELOW))
    let next = Math.min(height, limit)
    let fold = false
    document.body.classList.add('resizing', 'resizing-v')
    track(
      e.currentTarget,
      e.pointerId,
      (ev) => {
        const want = ev.clientY - top
        fold = want < MIN_HEIGHT - FOLD_PULL
        next = Math.round(Math.min(limit, Math.max(MIN_HEIGHT, want)))
        setHeight(next)
      },
      () => {
        document.body.classList.remove('resizing', 'resizing-v')
        if (fold) onFold(true)
        else localStorage.setItem(HEIGHT_KEY, String(next))
      }
    )
  }

  const startMove = (e: React.PointerEvent<HTMLDivElement>) => {
    dragged.current = false
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const dock = ref.current!
    const pane = dock.parentElement!
    const from = { x: e.clientX, y: e.clientY }
    const rect = dock.getBoundingClientRect()
    let grab = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    let w = rect.width
    let snap = false
    track(
      e.currentTarget,
      e.pointerId,
      (ev) => {
        if (!dragged.current) {
          if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_SLOP) return
          dragged.current = true
          document.body.classList.add('moving')
          if (!floating) {
            // Lifted off the top, it narrows to its floating width around the pointer.
            w = Math.min(rect.width, Number(localStorage.getItem(WIDTH_KEY)) || FLOAT_WIDTH)
            grab = { x: (grab.x * w) / rect.width, y: grab.y }
          }
        }
        const box = pane.getBoundingClientRect()
        const next = fit({ x: ev.clientX - box.left - grab.x, y: ev.clientY - box.top - grab.y, w }, pane.clientWidth, pane.clientHeight, dock.offsetHeight)
        snap = next.y < DOCK_TOP + SNAP
        setSnapping(snap)
        setPlace(next)
      },
      () => {
        document.body.classList.remove('moving')
        setSnapping(false)
        if (dragged.current && snap) setPlace(null)
      }
    )
  }

  /** Drag a side: a floating lesson moves that edge; a docked one, centred, grows or shrinks on both sides. */
  const startWiden = (side: 'left' | 'right') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const dock = ref.current!
    const pane = dock.parentElement!.getBoundingClientRect()
    const start = place
    let w = dock.getBoundingClientRect().width
    document.body.classList.add('resizing', 'resizing-x')
    track(
      e.currentTarget,
      e.pointerId,
      (ev) => {
        if (!start) {
          const reach = Math.abs(ev.clientX - (pane.left + pane.width / 2))
          w = Math.round(Math.max(Math.min(MIN_WIDTH, pane.width - 2 * DOCKED_MARGIN), Math.min(pane.width - 2 * DOCKED_MARGIN, 2 * reach)))
          setDockedWidth(w)
        } else if (side === 'right') {
          w = Math.round(Math.max(MIN_WIDTH, Math.min(pane.width - start.x - EDGE, ev.clientX - pane.left - start.x)))
          setPlace({ ...start, w })
        } else {
          const right = start.x + start.w
          const x = Math.round(Math.max(EDGE, Math.min(right - MIN_WIDTH, ev.clientX - pane.left)))
          w = right - x
          setPlace({ ...start, x, w })
        }
      },
      () => {
        document.body.classList.remove('resizing', 'resizing-x')
        localStorage.setItem(start ? WIDTH_KEY : DOCKED_WIDTH_KEY, String(w))
      }
    )
  }
  /** A double-click on a docked lesson's side puts its width back. */
  const resetWidth = () => {
    if (floating) return
    setDockedWidth(null)
    localStorage.removeItem(DOCKED_WIDTH_KEY)
  }

  return (
    <>
      {snapping && <div className="lesson-dock-slot" aria-hidden="true" data-testid="lesson-dock-slot" />}
      <div
        ref={ref}
        className={`lesson-dock ${folded ? 'folded' : ''} ${floating ? 'floating' : ''}`}
        style={{ ['--dock-max' as string]: `${height}px`, ...(place ? { left: place.x, top: place.y, width: place.w } : dockedWidth ? { ['--dock-w' as string]: `${dockedWidth}px` } : {}) }}
        role="region"
        aria-label="Open lesson"
        data-testid="lesson-dock"
      >
        <div
          className="lesson-dock-bar"
          onPointerDown={startMove}
          onClick={(e) => {
            if (folded && !dragged.current && !(e.target as HTMLElement).closest('button')) onFold(false)
          }}
          title={floating ? 'Drag to move it, or to the top to dock it' : 'Drag to move it anywhere over the chat'}
          data-testid="lesson-dock-bar"
        >
          <Icon name="study" size={15} />
          <span className="lesson-dock-kind">{session.type === 'review' ? 'Review' : 'Lesson'}</span>
          <RichText text={topic?.title ?? 'Lesson'} inline className="lesson-dock-title" />
          <span className="spacer" />
          {folded && hasDraft && <span className="lesson-dock-draft">draft kept</span>}
          <span className="lesson-dock-where" data-testid="lesson-dock-where">
            {where}
          </span>
          {floating && (
            <button className="icon-btn" onClick={() => setPlace(null)} title="Dock at the top" aria-label="Dock the lesson at the top" data-testid="lesson-dock-pin">
              <Icon name="pin" size={14} />
            </button>
          )}
          <button className="icon-btn" onClick={onMoveToTab} title="Show lessons in the Study tab instead" aria-label="Show lessons in the Study tab" data-testid="lesson-dock-to-tab">
            <Icon name="sidebar" size={14} />
          </button>
          <button className="icon-btn" onClick={onPopOut} title="Move the lesson into a window of its own" aria-label="Open the lesson in a window" data-testid="lesson-dock-popout">
            <Icon name="popOut" size={14} />
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
          <button className="icon-btn" onClick={onClose} title={session.endedAt ? 'Close' : 'Close (the lesson stays in progress)'} aria-label="Close the lesson" data-testid="lesson-dock-close">
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
        {!folded &&
          (['left', 'right'] as const).map((side) => (
            <div
              key={side}
              className={`lesson-dock-side ${side}`}
              onPointerDown={startWiden(side)}
              onDoubleClick={resetWidth}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the lesson's width"
              title={floating ? 'Drag to resize' : 'Drag to resize, double-click to reset'}
              data-testid={side === 'right' ? 'lesson-dock-side' : 'lesson-dock-side-left'}
            />
          ))}
      </div>
    </>
  )
}
