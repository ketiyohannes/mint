import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { Anchor, Annotation, Thread } from '@shared/types'
import { api } from '../../lib/api'
import { useApp } from '../../state/app'
import { Icon } from '../../components/Icon'
import { RichText } from '../../components/RichText'
import { ThreadView } from './ThreadView'
import { useStudy } from './context'

const POP_W = 380

/**
 * Initial popover position: beside the selection, inside the reader column
 * when it fits (so the side panel stays readable), always on screen.
 */
export function placeNear(rect: DOMRect | undefined): { x: number; y: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const reader = document.querySelector('.panel-page.active .reader-wrap')?.getBoundingClientRect()
  const left = reader ? reader.left + 8 : 12
  const right = reader ? reader.right - 8 : vw - 12
  if (!rect) return { x: Math.max(12, right - POP_W), y: 120 }
  let x: number
  if (rect.right + 16 + POP_W <= right) x = rect.right + 16
  else if (rect.left - 16 - POP_W >= left) x = rect.left - 16 - POP_W
  else x = Math.min(right - POP_W, Math.max(left, rect.left + rect.width / 2 - POP_W / 2))
  // Prefer just below the selection when the popover has to overlap the text column.
  const overlapsText = x < rect.right && x + POP_W > rect.left
  let y = overlapsText ? rect.bottom + 12 : rect.top - 40
  if (y + 420 > vh) y = overlapsText ? Math.max(64, rect.top - 432) : vh - 432
  // Stay over the materials column (never the sidebar or the tutor) when it is wide enough.
  const minX = right - left >= POP_W ? left : 12
  const maxX = right - left >= POP_W ? right - POP_W : vw - POP_W - 12
  return { x: Math.max(minX, Math.min(maxX, x)), y: Math.max(64, y) }
}

/** A non-modal, draggable floating window. The page behind it stays usable. */
function Floating({ pos, onMove, children, testId }: { pos: { x: number; y: number }; onMove: (p: { x: number; y: number }) => void; children: (dragHandle: (e: React.MouseEvent) => void) => ReactNode; testId?: string }): JSX.Element {
  const drag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const startX = e.clientX - pos.x
    const startY = e.clientY - pos.y
    const move = (ev: MouseEvent) => {
      onMove({
        x: Math.min(window.innerWidth - 120, Math.max(0, ev.clientX - startX)),
        y: Math.min(window.innerHeight - 60, Math.max(40, ev.clientY - startY))
      })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return (
    <div className="popover" style={{ left: pos.x, top: pos.y }} role="dialog" aria-modal="false" data-testid={testId}>
      {children(drag)}
    </div>
  )
}

export interface AskState {
  key: number
  anchor: Anchor
  threadId?: string
  pos: { x: number; y: number }
}

export function AskPopover({
  state,
  thread,
  onMove,
  onMinimize,
  onClose,
  onExpand,
  onThread
}: {
  state: AskState
  thread: Thread | undefined
  onMove: (p: { x: number; y: number }) => void
  onMinimize: () => void
  onClose: () => void
  onExpand: () => void
  onThread: (threadId: string) => void
}): JSX.Element {
  const { run } = useApp()
  const study = useStudy()
  const a = state.anchor
  const quote = a.kind === 'source' || a.kind === 'message' ? a.quote : a.kind === 'diagram' ? `Diagram part: ${a.label}` : ''
  const where = a.kind === 'source' ? a.sectionLabel : a.kind === 'message' ? 'Follow-up on a reply' : a.kind === 'diagram' ? 'Diagram' : 'Ask'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (thread) onMinimize()
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [thread, onMinimize, onClose])

  const parent = a.kind === 'message' ? study.bundle.threads.find((t) => t.id === a.threadId) : undefined

  return (
    <Floating pos={state.pos} onMove={onMove} testId="ask-popover">
      {(drag) => (
        <>
          <div className="popover-head" onMouseDown={drag}>
            <Icon name="ask" size={13} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{where}</span>
            {parent && (
              <button className="btn ghost sm" onClick={() => study.ask(parent.anchor, undefined, parent.id)} title="Back to the original thread">
                <Icon name="back" size={12} /> Back
              </button>
            )}
            <span className="spacer" />
            {thread && (
              <button
                className="btn ghost sm icon"
                title="Delete thread"
                aria-label="Delete thread"
                onClick={() => {
                  onClose()
                  void run(() => api.threads.remove(study.classId, thread.id))
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            )}
            <button className="btn ghost sm icon" title="Open in side panel" aria-label="Open in side panel" onClick={onExpand}>
              <Icon name="expand" size={13} />
            </button>
            <button className="btn ghost sm icon" title={thread ? 'Pin as a sticky (Esc)' : 'Close (Esc)'} aria-label="Minimize" onClick={thread ? onMinimize : onClose} data-testid="popover-minimize">
              <Icon name={thread ? 'minus' : 'x'} size={13} />
            </button>
          </div>
          {quote && <div className="quote-line">“{quote}”</div>}
          <ThreadView anchor={a} thread={thread} onThread={onThread} voiceOwner="popover" autoFocus suggestions={a.kind !== 'general'} />
        </>
      )}
    </Floating>
  )
}

export function NotePopover({ annotation, pos, onMove, onClose }: { annotation: Annotation; pos: { x: number; y: number }; onMove: (p: { x: number; y: number }) => void; onClose: () => void }): JSX.Element {
  const { run } = useApp()
  const study = useStudy()
  const [text, setText] = useState(annotation.text ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const save = async () => {
    await run(() => api.annotations.update(study.classId, annotation.id, text))
    onClose()
  }
  return (
    <Floating pos={pos} onMove={onMove} testId="note-popover">
      {(drag) => (
        <>
          <div className="popover-head" onMouseDown={drag}>
            <Icon name="note" size={13} /> Sticky note
            <span className="spacer" />
            <button
              className="btn ghost sm icon"
              aria-label="Delete note"
              onClick={() => {
                onClose()
                void run(() => api.annotations.remove(study.classId, annotation.id))
              }}
            >
              <Icon name="trash" size={13} />
            </button>
            <button className="btn ghost sm icon" aria-label="Close" onClick={onClose}>
              <Icon name="x" size={13} />
            </button>
          </div>
          <div className="quote-line" style={{ borderLeftColor: 'var(--note-color)' }}>
            “{annotation.anchor.quote}”
          </div>
          <div style={{ padding: 12 }}>
            <textarea
              ref={ref}
              className="textarea"
              placeholder="Your note, in your own words…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
                if (e.key === 'Escape') onClose()
              }}
              data-testid="note-input"
            />
            <div className="row" style={{ marginTop: 8 }}>
              <span className="hint">⌘↵ to save</span>
              <span className="spacer" />
              <button className="btn primary sm" onClick={save} data-testid="note-save">
                Save
              </button>
            </div>
          </div>
        </>
      )}
    </Floating>
  )
}

export function TermPopover({ anchor, pos, onMove, onClose }: { anchor: Extract<Anchor, { kind: 'source' }>; pos: { x: number; y: number }; onMove: (p: { x: number; y: number }) => void; onClose: () => void }): JSX.Element {
  const { toast } = useApp()
  const study = useStudy()
  const [term, setTerm] = useState(anchor.quote.length <= 60 ? anchor.quote.replace(/[.,;:!?]+$/, '') : '')
  const [definition, setDefinition] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const submit = async () => {
    setBusy(true)
    try {
      const res = await api.glossary.propose(study.classId, term, definition, anchor)
      setFeedback({ ok: res.accepted, text: res.feedback })
      if (res.accepted) {
        toast(`"${term}" added to your glossary.`)
        setTimeout(onClose, 1400)
      }
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message.replace(/^.*mint:/, '') : String(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Floating pos={pos} onMove={onMove} testId="term-popover">
      {(drag) => (
        <>
          <div className="popover-head" onMouseDown={drag}>
            <Icon name="term" size={13} /> Add to my glossary
            <span className="spacer" />
            <button className="btn ghost sm icon" aria-label="Close" onClick={onClose}>
              <Icon name="x" size={13} />
            </button>
          </div>
          <div style={{ padding: 12 }}>
            <p className="small muted" style={{ marginTop: 0 }}>
              Terms join your glossary only once you can define them. Write it in your own words; the tutor checks it against your materials.
            </p>
            <div className="field">
              <label htmlFor="term-name">Term</label>
              <input id="term-name" className="input" value={term} onChange={(e) => setTerm(e.target.value)} data-testid="term-name" />
            </div>
            <div className="field">
              <label htmlFor="term-def">Your definition</label>
              <textarea id="term-def" className="textarea" value={definition} onChange={(e) => setDefinition(e.target.value)} data-testid="term-definition" />
            </div>
            {feedback && <RichText text={feedback.text} className={`verdict ${feedback.ok ? 'pass' : 'partial'} small`} />}
            <div className="row" style={{ marginTop: 8 }}>
              <span className="spacer" />
              <button className="btn primary sm" disabled={busy || !term.trim() || !definition.trim()} onClick={submit} data-testid="term-submit">
                {busy ? <span className="spinner" /> : null} Check and add
              </button>
            </div>
          </div>
        </>
      )}
    </Floating>
  )
}

export function SelectionToolbar({
  rect,
  onChat,
  onAsk,
  onNote,
  onHighlight,
  onDiagram,
  onTerm,
  onSearch
}: {
  rect: DOMRect
  /** Bring the passage into the main chat. */
  onChat: () => void
  /** Ask about it in a side chat beside the page. */
  onAsk: () => void
  onNote: () => void
  onHighlight: () => void
  onDiagram: () => void
  onTerm: () => void
  onSearch: () => void
}): JSX.Element {
  const top = Math.max(56, rect.top - 8)
  const left = Math.min(window.innerWidth - 240, Math.max(240, rect.left + rect.width / 2))
  // onMouseDown preventDefault keeps the text selection alive while clicking.
  return (
    <div className="sel-toolbar" style={{ top, left }} onMouseDown={(e) => e.preventDefault()} data-testid="selection-toolbar">
      <button onClick={onChat} data-testid="sel-chat" title="Discuss this passage in the main chat">
        <Icon name="chat" size={14} /> Chat
      </button>
      <button onClick={onAsk} data-testid="sel-ask" title="Ask about it in a side chat beside the page">
        <Icon name="ask" size={14} /> Side chat
      </button>
      <button onClick={onNote} data-testid="sel-note">
        <Icon name="note" size={14} /> Note
      </button>
      <button onClick={onHighlight} data-testid="sel-highlight">
        <Icon name="highlight" size={14} /> Highlight
      </button>
      <button onClick={onDiagram} data-testid="sel-diagram">
        <Icon name="diagram" size={14} /> Diagram
      </button>
      <button onClick={onTerm} data-testid="sel-term">
        <Icon name="term" size={14} /> Term
      </button>
      <button onClick={onSearch} data-testid="sel-search" title="Search the web in the Browser tab">
        <Icon name="globe" size={14} /> Search
      </button>
    </div>
  )
}
