import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { ChatCommand } from '@shared/types'
import { Icon, type IconName } from '../../components/Icon'

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
  onSubmit: (text: string) => void
  busy: boolean
  onStop?: () => void
  placeholder: string
  centered?: boolean
  autoFocus?: boolean
  providerLabel: string
  onProvider: () => void
  mic: { status: string; toggle: () => void }
  onAddMaterials: () => void
  /** Prefill (e.g. from a suggestion chip) without sending. */
  prefill?: { text: string; nonce: number } | null
  /** A highlighted passage attached to the next message. */
  quote?: { text: string; source: string } | null
  onClearQuote?: () => void
}

/** The prompt box: auto-growing input, slash commands, actions menu, provider, mic, send/stop. */
export function Composer(props: Props): JSX.Element {
  const { onSubmit, busy, onStop, placeholder, centered, autoFocus, providerLabel, onProvider, mic, onAddMaterials, prefill, quote, onClearQuote } = props
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  // Attaching a passage puts the cursor in the box, ready for the question.
  useEffect(() => {
    if (quote) inputRef.current?.focus()
  }, [quote])

  useEffect(() => {
    if (!prefill) return
    setDraft(prefill.text)
    inputRef.current?.focus()
  }, [prefill])

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [draft])

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const slashQuery = /^\/(\w*)$/.exec(draft)?.[1]
  const matches = slashQuery !== undefined ? SLASH_COMMANDS.filter((c) => c.command.startsWith(slashQuery.toLowerCase())) : []
  const showSlash = matches.length > 0

  const send = () => {
    const text = draft.trim()
    if ((!text && !quote) || busy) return
    onSubmit(text)
    setDraft('')
  }

  const complete = (command: ChatCommand) => {
    setDraft(`/${command} `)
    setSlashIndex(0)
    inputRef.current?.focus()
  }

  const action = (text: string) => {
    setMenu(false)
    if (text.endsWith(' ')) {
      setDraft(text)
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
          setDraft(e.target.value)
          setSlashIndex(0)
        }}
        onKeyDown={(e) => {
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
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
              >
                <Icon name="upload" size={14} /> Add materials…
              </button>
              <button className="menu-item" onClick={() => action('/lesson')} data-testid="action-lesson">
                <Icon name="lesson" size={14} /> Start the next lesson
              </button>
              <button className="menu-item" onClick={() => action('/quiz')} data-testid="action-quiz">
                <Icon name="quiz" size={14} /> Quiz me
              </button>
              <button className="menu-item" onClick={() => action('/code')} data-testid="action-code">
                <Icon name="code" size={14} /> Code exercise
              </button>
              <button className="menu-item" onClick={() => action('/diagram ')} data-testid="action-diagram">
                <Icon name="diagram" size={14} /> Diagram…
              </button>
            </div>
          )}
        </div>
        <button className="provider-pill" onClick={onProvider} title="Change the agent harness in Settings">
          <Icon name="sparkle" size={12} />
          {providerLabel}
          <Icon name="caret" size={10} />
        </button>
        <span className="spacer" />
        <span className="composer-hint">/ for tools</span>
        <button
          className={`icon-btn mic ${mic.status === 'recording' ? 'rec' : mic.status === 'transcribing' ? 'busy' : ''}`}
          onClick={mic.toggle}
          aria-label={mic.status === 'recording' ? 'Stop recording' : 'Talk (or hold Space)'}
          title="Click, or hold Space, to talk"
          data-testid="mic"
        >
          {mic.status === 'transcribing' ? <span className="spinner tiny" /> : <Icon name="mic" size={14} />}
        </button>
        {busy && onStop ? (
          <button className="send-btn" aria-label="Stop" onClick={onStop} data-testid="ask-stop">
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
