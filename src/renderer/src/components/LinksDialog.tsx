import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { MAX_LINKS, linksFromInput } from '@shared/links'
import type { ClassMode } from '@shared/types'
import { Icon } from './Icon'

/** How a class made from links teaches. A quick course has no materials, so it is not offered. */
export type LinkClassMode = Exclude<ClassMode, 'quick'>

interface Props {
  title: string
  /** What the button says for this many links. */
  action: (count: number) => string
  /**
   * Take the links. Resolves to true when the dialog is done; false keeps it
   * open with the links still in it (nothing could be added).
   */
  onSubmit: (links: string[], mode: LinkClassMode) => Promise<boolean>
  onClose: () => void
  /** Also ask how the class teaches: a new class is being made from the links. */
  chooseMode?: boolean
}

/**
 * Where links are given as materials: one or many, pasted in any shape. Used
 * for a class that exists and for one about to be made.
 */
export function LinksDialog({ title, action, onSubmit, onClose, chooseMode }: Props): JSX.Element {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<LinkClassMode>('course')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const links = linksFromInput(text)

  // The dialog decides before anything behind it does: Escape closes this, not a side chat or a menu.
  const state = useRef({ busy, onClose })
  state.current = { busy, onClose }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      if (!state.current.busy) state.current.onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  async function submit() {
    if (!links.length || busy) return
    setBusy(true)
    const done = await onSubmit(links, mode).catch(() => false)
    // Done: the dialog is gone by now. Not done: back to the links, to fix them.
    if (done) return
    setBusy(false)
    input.current?.focus()
  }

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} data-testid="links-dialog-backdrop">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        data-testid="links-dialog"
      >
        <div className="dialog-head">
          <Icon name="link" size={15} />
          <b>{title}</b>
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close" data-testid="links-close">
            <Icon name="x" size={13} />
          </button>
        </div>
        <textarea
          ref={input}
          className="input dialog-links"
          autoFocus
          rows={4}
          spellCheck={false}
          placeholder="Paste links, one per line"
          value={text}
          readOnly={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds, as in the chat box; Shift+Enter starts another line.
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            void submit()
          }}
          data-testid="links-input"
        />
        <p className="hint">Web pages, PDFs, Word and Google documents, YouTube videos and playlists. For a page you have to sign in to, open it in the Browser tab and add it from there.</p>
        {links.length > MAX_LINKS && <p className="hint warn">Only the first {MAX_LINKS} links are added at a time.</p>}
        <div className="dialog-foot">
          {chooseMode && (
            <div className="seg" role="group" aria-label="Mode" data-testid="links-mode">
              {(['course', 'simple'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={mode === m ? 'on' : ''}
                  title={m === 'course' ? 'A plan of lessons with checks' : 'No lessons: a list of what is in your material, explained when you pick'}
                  onClick={() => setMode(m)}
                  data-testid={`links-mode-${m}`}
                >
                  {m === 'course' ? 'Course' : 'Simple'}
                </button>
              ))}
            </div>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary sm" disabled={!links.length || busy} data-testid="links-add">
            {busy ? <span className="spinner tiny" /> : <Icon name="plus" size={12} />} {busy ? 'Adding…' : action(Math.min(links.length, MAX_LINKS))}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
