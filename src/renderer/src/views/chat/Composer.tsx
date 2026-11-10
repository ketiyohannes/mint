import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react'
import type { ChatCommand } from '@shared/types'
import { Icon, type IconName } from '../../components/Icon'
import { ModelPicker } from '../../components/ModelPicker'
import { isTypingTarget } from '../../lib/shortcuts'

export const SLASH_COMMANDS: { command: ChatCommand; args: string; description: string; icon: IconName }[] = [
  { command: 'lesson', args: '[topic]', description: 'Start the next lesson (or a named one)', icon: 'lesson' },
  { command: 'quiz', args: '[focus]', description: 'A short quiz on what you are studying', icon: 'quiz' },
  { command: 'code', args: '[focus] [python|js]', description: 'A small coding exercise with tests', icon: 'code' },
  { command: 'diagram', args: '<what to draw>', description: 'An interactive diagram you can explore', icon: 'diagram' },
  { command: 'plan', args: '[what to change]', description: 'Re-plan the curriculum', icon: 'path' }
]

/** Parse "/quiz eigenvalues" into a command; null for ordinary text. */
export function parseSlash(text: string): { command: ChatCommand; arg: string } | null {
  const m = /^\/(\w+)\b\s*([\s\S]*)$/.exec(text.trim())
  if (!m) return null
  const hit = SLASH_COMMANDS.find((c) => c.command === m[1].toLowerCase())
  return hit ? { command: hit.command, arg: m[2].trim() } : null
}

interface Props {
  /** The unsent text. The chat owns it, so it outlives this box (which moves when the first message arrives). */
  draft: string
  onDraft: (text: string) => void
  /** The text box, so the chat can put the cursor in it. */
  inputRef: RefObject<HTMLTextAreaElement | null>
  onSubmit: (text: string) => void
  busy: boolean
  onStop?: () => void
  placeholder: string
  centered?: boolean
  autoFocus?: boolean
  onAddMaterials: () => void
  /** The learner's last message: ↑ in an empty box brings it back. */
  recall?: string
  /** A highlighted passage attached to the next message. */
  quote?: { text: string; source: string } | null
  onClearQuote?: () => void
}

/** The prompt box: auto-growing input, slash commands, actions menu, model picker, send/stop. */
export function Composer(props: Props): JSX.Element {
  const { draft, onDraft, inputRef, onSubmit, busy, onStop, placeholder, centered, autoFocus, onAddMaterials, recall, quote, onClearQuote } = props
  const [menu, setMenu] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  /** Esc puts the tools list away until the text changes. */
  const [slashOff, setSlashOff] = useState(false)
  useEffect(() => setSlashOff(false), [draft])
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus, inputRef])

  // Attaching a passage puts the cursor in the box, ready for the question.
  useEffect(() => {
    if (quote) inputRef.current?.focus()
  }, [quote, inputRef])

  // "/" from anywhere that is not a text field goes to the box and lists the tools.
  const latest = useRef({ draft, onDraft })
  latest.current = { draft, onDraft }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.defaultPrevented || isTypingTarget(e.target)) return
      e.preventDefault()
      inputRef.current?.focus()
      if (!latest.current.draft) latest.current.onDraft('/')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inputRef])

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [draft, inputRef])

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenu(false)
      // Back to the button that opened the menu.
      menuRef.current?.querySelector('button')?.focus()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const slashQuery = /^\/(\w*)$/.exec(draft)?.[1]
  const matches = slashQuery !== undefined ? SLASH_COMMANDS.filter((c) => c.command.startsWith(slashQuery.toLowerCase())) : []
  const showSlash = matches.length > 0 && !slashOff

  const send = () => {
    const text = draft.trim()
    if ((!text && !quote) || busy) return
    onSubmit(text)
    onDraft('')
  }

  const complete = (command: ChatCommand) => {
    onDraft(`/${command} `)
    setSlashIndex(0)
    inputRef.current?.focus()
  }

  const action = (text: string) => {
    setMenu(false)
    if (text.endsWith(' ')) {
      onDraft(text)
      inputRef.current?.focus()
    } else if (!busy) onSubmit(text)
  }

  return (
    <div className={`composer-box ${centered ? 'centered' : ''}`} data-testid="composer">
      {showSlash && (
        <div className="slash-menu" role="listbox" data-testid="slash-menu">
          {matches.map((c, i) => (
            <button
              key={c.command}
              role="option"
              aria-selected={i === slashIndex}
              className={`slash-item ${i === slashIndex ? 'on' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                complete(c.command)
              }}
            >
              <Icon name={c.icon} size={13} />
              <b>/{c.command}</b>
              <span className="muted">{c.args}</span>
              <span className="slash-desc">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {quote && (
        <div className="composer-quote" data-testid="composer-quote">
          <Icon name="quote" size={13} />
          <div className="composer-quote-text">
            <span className="ellipsis">{quote.text}</span>
            {quote.source && <span className="muted ellipsis">{quote.source}</span>}
          </div>
          <button className="icon-btn" aria-label="Remove the quoted passage" title="Remove" onClick={onClearQuote}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <textarea
        ref={inputRef}
        rows={1}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => {
          onDraft(e.target.value)
          setSlashIndex(0)
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (showSlash) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSlashIndex((i) => (i + 1) % matches.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSlashIndex((i) => (i - 1 + matches.length) % matches.length)
              return
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
              e.preventDefault()
              complete(matches[Math.min(slashIndex, matches.length - 1)].command)
              return
            }
          }
          if (e.key === 'Escape' && (showSlash || (busy && onStop))) {
            // Esc here means this box only: nothing else (a side chat, a menu) closes with it.
            e.preventDefault()
            e.stopPropagation()
            if (showSlash) setSlashOff(true)
            else onStop?.()
            return
          }
          if (e.key === 'ArrowUp' && !draft && recall) {
            e.preventDefault()
            onDraft(recall)
            return
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        data-testid="ask-input"
      />
      <div className="composer-bar">
        <div className="menu-anchor" ref={menuRef}>
          <button className="icon-btn" aria-label="Actions" title="Actions" onClick={() => setMenu((m) => !m)} data-testid="composer-actions">
            <Icon name="plus" size={15} />
          </button>
          {menu && (
            <div className="menu up">
              <button
                className="menu-item"
                onClick={() => {
                  setMenu(false)
                  onAddMaterials()
                }}
                data-testid="action-add-materials"
              >
                <Icon name="upload" size={14} /> Add materials…
              </button>
              <button className="menu-item" disabled={busy} onClick={() => action('/lesson')} data-testid="action-lesson">
                <Icon name="lesson" size={14} /> Start the next lesson
              </button>
              <button className="menu-item" disabled={busy} onClick={() => action('/quiz')} data-testid="action-quiz">
                <Icon name="quiz" size={14} /> Quiz me
              </button>
              <button className="menu-item" disabled={busy} onClick={() => action('/code')} data-testid="action-code">
                <Icon name="code" size={14} /> Code exercise
              </button>
              <button className="menu-item" onClick={() => action('/diagram ')} data-testid="action-diagram">
                <Icon name="diagram" size={14} /> Diagram…
              </button>
            </div>
          )}
        </div>
        <ModelPicker />
        <span className="spacer" />
        <span className="composer-hint">/ for tools</span>
        {busy && onStop ? (
          <button className="send-btn" aria-label="Stop" title="Stop (Esc)" onClick={onStop} data-testid="ask-stop">
            <Icon name="stop" size={11} />
          </button>
        ) : (
          <button className="send-btn" aria-label="Send" disabled={(!draft.trim() && !quote) || busy} onClick={send} data-testid="ask-send">
            {busy ? <span className="spinner tiny" /> : <Icon name="arrowUp" size={14} />}
          </button>
        )}
      </div>
    </div>
  )
}
