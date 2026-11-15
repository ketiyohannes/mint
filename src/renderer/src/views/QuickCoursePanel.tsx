import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { ClassBundle, QuickCourse } from '@shared/types'
import { quickStreamSection, readingTime } from '@shared/mode'
import { useApp } from '../state/app'
import { api } from '../lib/api'
import { Icon } from '../components/Icon'
import { RichText } from '../components/RichText'

interface Props {
  bundle: ClassBundle
  /** Attach a highlighted passage to the next chat message. */
  onQuote: (text: string, source: string) => void
}

/** How far down the course the learner was, per class: a long one is read over several sittings. */
const POSITION_KEY = 'mint.quickCourse.position'

function savedPosition(classId: string): number {
  try {
    const all = JSON.parse(localStorage.getItem(POSITION_KEY) ?? '{}') as Record<string, unknown>
    const top = Number(all[classId])
    return Number.isFinite(top) && top > 0 ? top : 0
  } catch {
    return 0
  }
}

function savePosition(classId: string, top: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(POSITION_KEY) ?? '{}') as Record<string, number>
    all[classId] = Math.round(top)
    localStorage.setItem(POSITION_KEY, JSON.stringify(all))
  } catch {
    // The course opens at the top next time.
  }
}

/** A class was deleted: its place in the course goes with it. */
export function forgetQuickPosition(classId: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(POSITION_KEY) ?? '{}') as Record<string, number>
    delete all[classId]
    localStorage.setItem(POSITION_KEY, JSON.stringify(all))
  } catch {
    // Nothing to clean up.
  }
}

/**
 * Quick mode's page: the course mint wrote, read top to bottom like an
 * article. Parts appear as they are written. Highlight a passage to ask about
 * it in the chat.
 */
export function QuickCoursePanel({ bundle, onQuote }: Props): JSX.Element {
  const { run } = useApp()
  const classId = bundle.meta.id
  const course = bundle.quickCourse
  const scrollRef = useRef<HTMLDivElement>(null)

  // The part being written arrives as a stream until it is stored with the course.
  const [live, setLive] = useState<{ sectionId: string; text: string } | null>(null)
  useEffect(
    () =>
      api.on.stream((e) => {
        const sectionId = quickStreamSection(classId, e.streamId)
        if (!sectionId || !e.delta) return
        setLive((l) => (l && l.sectionId === sectionId ? { sectionId, text: l.text + e.delta } : { sectionId, text: e.delta! }))
      }),
    [classId]
  )

  // A part written again (after a stop) starts from nothing, not from what the stopped run had streamed.
  const status = course?.status
  useEffect(() => {
    if (status !== 'writing') setLive(null)
  }, [status])

  // Open where the learner left off; remember where they are as they read.
  const hasCourse = Boolean(course)
  useLayoutEffect(() => {
    if (hasCourse && scrollRef.current) scrollRef.current.scrollTop = savedPosition(classId)
  }, [hasCourse, classId])

  const [pick, setPick] = useState<{ text: string; source: string; x: number; y: number } | null>(null)
  const placePick = useCallback(() => {
    const sel = window.getSelection()
    const root = scrollRef.current
    if (!sel || sel.isCollapsed || !sel.rangeCount || !root || !course) return setPick(null)
    const range = sel.getRangeAt(0)
    const node = range.commonAncestorContainer
    const part = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-section-id]')
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (!part || !text || !root.contains(part)) return setPick(null)
    const rect = range.getBoundingClientRect()
    const title = course.sections.find((s) => s.id === part.dataset.sectionId)?.title
    setPick({ text: text.slice(0, 600), source: [course.title, title].filter(Boolean).join(' · '), x: rect.left + rect.width / 2, y: rect.top })
  }, [course])

  // The toolbar goes when the selection does.
  const picking = Boolean(pick)
  useEffect(() => {
    if (!picking) return
    const onChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setPick(null)
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [picking])

  if (!course) {
    return (
      <div className="panel-pad" data-testid="course-empty">
        <div className="study-empty">
          <Icon name="bolt" size={22} />
          <p>Say in the chat what you want to learn. mint writes a short course on it, and you read it here.</p>
        </div>
      </div>
    )
  }

  const written = course.sections.filter((s) => s.body !== undefined).length
  const jump = (sectionId: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(sectionId)}"]`)
    const scroller = scrollRef.current
    // Scroll the page only: scrollIntoView would try the app shell too.
    if (el && scroller) scroller.scrollTo({ top: el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12, behavior: 'smooth' })
  }

  return (
    <div
      className="course-scroll"
      ref={scrollRef}
      onMouseUp={() => setTimeout(placePick, 0)}
      onScroll={(e) => {
        savePosition(classId, e.currentTarget.scrollTop)
        if (pick) placePick()
      }}
      data-testid="course"
    >
      <article className="course">
        <header className="course-head">
          <h1 className="course-title" data-testid="course-title">
            {course.title}
          </h1>
          {course.summary && <RichText text={course.summary} className="course-summary" />}
          <div className="course-meta">
            <span>
              <Icon name="timer" size={13} /> {readingTime(course.minutes)} to read
            </span>
            <span>
              {course.sections.length} part{course.sections.length === 1 ? '' : 's'}
            </span>
            <CourseStatus course={course} written={written} onStop={() => void run(() => api.quick.stop(classId))} onResume={() => void run(() => api.quick.resume(classId))} />
          </div>
        </header>

        {course.sections.length > 1 && (
          <nav className="course-toc" aria-label="Parts" data-testid="course-toc">
            {course.sections.map((s, i) => (
              <button key={s.id} className={s.body === undefined ? 'unwritten' : ''} onClick={() => jump(s.id)} data-testid="course-toc-item">
                <span className="muted">{String(i + 1).padStart(2, '0')}</span>
                <span className="ellipsis">{s.title}</span>
                <span className="muted small">{readingTime(s.minutes)}</span>
              </button>
            ))}
          </nav>
        )}

        {course.sections.map((s, i) => {
          const streaming = s.body === undefined && live?.sectionId === s.id && course.status === 'writing' ? live.text : null
          return (
            <section key={s.id} className="course-part" data-section-id={s.id} data-testid="course-part">
              <h2>
                <span className="muted">{String(i + 1).padStart(2, '0')}</span> {s.title}
              </h2>
              {s.body !== undefined ? (
                <RichText text={s.body} />
              ) : streaming ? (
                <RichText text={streaming} streaming />
              ) : (
                <p className="muted small course-pending" data-testid="course-pending">
                  {course.status === 'writing' && i === written ? (
                    <>
                      <span className="spinner tiny" /> Writing this part…
                    </>
                  ) : (
                    'Not written yet.'
                  )}
                </p>
              )}
            </section>
          )
        })}
      </article>

      {pick && (
        <div className="sel-toolbar floating-ask" style={{ left: pick.x, top: Math.max(8, pick.y - 44) }} onMouseDown={(e) => e.preventDefault()}>
          <button
            onClick={() => {
              onQuote(pick.text, pick.source)
              setPick(null)
              window.getSelection()?.removeAllRanges()
            }}
            data-testid="course-quote"
          >
            <Icon name="chat" size={14} /> Ask in chat
          </button>
        </div>
      )}
    </div>
  )
}

/** Where the writing stands, with the way to stop it or to go on. */
function CourseStatus({ course, written, onStop, onResume }: { course: QuickCourse; written: number; onStop: () => void; onResume: () => void }): JSX.Element | null {
  const total = course.sections.length
  if (course.status === 'ready') return null
  if (course.status === 'writing') {
    return (
      <span className="course-status" data-testid="course-status">
        <span className="spinner tiny" /> Writing part {Math.min(written + 1, total)} of {total}
        <button className="link-btn" onClick={onStop} data-testid="course-stop">
          Stop
        </button>
      </span>
    )
  }
  return (
    <span className={`course-status ${course.status === 'failed' ? 'warn' : ''}`} title={course.error} data-testid="course-status">
      {course.status === 'failed' ? 'The writing stopped on an error' : 'Stopped'}: {written} of {total} parts written
      <button className="link-btn" onClick={onResume} data-testid="course-resume">
        <Icon name="play" size={11} /> Write the rest
      </button>
    </span>
  )
}
