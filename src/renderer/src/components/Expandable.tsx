import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { matchesShortcut } from '../lib/shortcuts'
import type { CodeEditorHandle } from './CodeEditor'

export interface Expansion {
  open: boolean
  toggle: () => void
  close: () => void
  /** Goes on the code editor: it gets the caret back each time it changes place. */
  editor: RefObject<CodeEditorHandle | null>
  /** Goes on the element that holds the editor: the shortcut works from anywhere in it. */
  onKeyDown: (e: KeyboardEvent) => void
}

/** Whether a code editor is in its window over the app, and the ways to put it there and back. */
export function useExpansion(): Expansion {
  const [open, setOpen] = useState(false)
  const editor = useRef<CodeEditorHandle>(null)
  const toggle = useCallback(() => setOpen((o) => !o), [])
  const close = useCallback(() => setOpen(false), [])

  // Moving the editor takes the focus off it (as does the button that moved it).
  // In the window it scrolls inside itself, from the top: the caret's line is
  // brought into view. Back on the page, the page stays where it was.
  const was = useRef(open)
  useEffect(() => {
    if (was.current === open) return
    was.current = open
    editor.current?.focus(open)
  }, [open])

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!matchesShortcut(e.nativeEvent, 'expandCode')) return
      e.preventDefault()
      toggle()
    },
    [toggle]
  )
  return { open, toggle, close, editor, onKeyDown }
}

interface Props {
  open: boolean
  onClose: () => void
  /** What the window is, for a screen reader. */
  label: string
  children: ReactNode
  testId?: string
}

/**
 * Content that can leave its place on the page for a window over the app, and
 * come back. It is the same content in both places, not a copy: the element it
 * is rendered into is moved, so an editor keeps its text, caret and undo
 * history, and whatever else is in there keeps its state.
 */
export function Expandable({ open, onClose, label, children, testId = 'code-window' }: Props): JSX.Element {
  const [node] = useState(() => {
    const el = document.createElement('div')
    el.className = 'expand-node'
    return el
  })
  const home = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const place = home.current
    if (!place) return
    // The page keeps the room the content took, so nothing around it jumps while it is away.
    place.style.minHeight = open ? `${place.offsetHeight}px` : ''
    ;(open ? frame.current : place)?.appendChild(node)
  }, [open, node])

  // Escape closes the window, unless a pop-up of the editor is showing
  // (completions, search): that one goes first. The window decides before the
  // editor sees the key, because the editor also keeps Escape for states that
  // show nothing, and the key would then seem to do nothing. Listened for on
  // the element: the content is rendered from another place in the React
  // tree, so React would not bring its key presses here.
  const closed = useRef(onClose)
  closed.current = onClose
  useEffect(() => {
    const el = frame.current
    if (!open || !el) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || el.querySelector('.cm-tooltip-autocomplete, .cm-panel')) return
      e.preventDefault()
      // Neither the editor nor what is behind the window (a side chat, a menu) takes the key too.
      e.stopPropagation()
      closed.current()
    }
    el.addEventListener('keydown', onKey, true)
    return () => el.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <>
      <div className="expand-home" ref={home} />
      {createPortal(children, node)}
      {open &&
        createPortal(
          <div className="expand-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid={`${testId}-backdrop`}>
            <div className="expand-window" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={frame} data-testid={testId} />
          </div>,
          document.body
        )}
    </>
  )
}
