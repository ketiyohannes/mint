import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { RUNG_LABELS, type Anchor, type Thread, type ThreadMessage } from '@shared/types'
import { api, errorMessage, newStreamId } from '../../lib/api'
import { useApp } from '../../state/app'
import { Markdown } from '../../components/Markdown'
import { Icon } from '../../components/Icon'
import { useStudy } from './context'

interface Pending {
  streamId: string
  user?: string
  text: string
  error?: string
}

interface Props {
  anchor: Anchor
  thread: Thread | undefined
  /** Called as soon as the thread id is known (start of the reply stream, and again on completion). */
  onThread: (threadId: string) => void
  /** Owner key for voice dictation routing. */
  voiceOwner: string
  autoFocus?: boolean
  suggestions?: boolean
  /** Submit this transcript as the first question as soon as the view mounts. */
  initialVoice?: string
}

const SUGGESTIONS = ['What does this mean?', 'Why is this true?', 'Give me an example', 'How does this connect to what I know?']

/** One Ask conversation: messages, the help ladder, and the composer. */
export function ThreadView({ anchor, thread, onThread, voiceOwner, autoFocus, suggestions, initialVoice }: Props): JSX.Element {
  const { toast, settings } = useApp()
  const study = useStudy()
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [local, setLocal] = useState<Thread | undefined>(thread)
  const [follow, setFollow] = useState<{ messageId: string; quote: string; x: number; y: number } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const viaVoice = useRef(false)
  const onThreadRef = useRef(onThread)
  onThreadRef.current = onThread

  // Prefer the freshest copy: the live bundle once it has caught up.
  const shown = useMemo(() => {
    if (!thread) return local
    if (!local || local.id !== thread.id) return thread
    return thread.messages.length >= local.messages.length ? thread : local
  }, [thread, local])

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [shown?.messages.length, pending?.text])

  // One subscription for the view's lifetime; the active stream id lives in a ref
  // so no event can arrive before the listener exists.
  const streamRef = useRef<string | null>(null)
  useEffect(
    () =>
      api.on.stream((e) => {
        if (!streamRef.current || e.streamId !== streamRef.current) return
        if (e.threadId) onThreadRef.current(e.threadId)
        setPending((p) => (p && p.streamId === e.streamId ? { ...p, text: p.text + (e.delta ?? ''), error: e.error ?? p.error } : p))
      }),
    []
  )

  async function submit(text: string, via: 'text' | 'voice') {
    const message = text.trim()
    if (!message || pending) return
    viaVoice.current = via === 'voice'
    const streamId = newStreamId()
    streamRef.current = streamId
    setPending({ streamId, user: message, text: '' })
    setDraft('')
    try {
      const out = shown
        ? await api.threads.send({ classId: study.classId, threadId: shown.id, message, via, streamId, voice: via === 'voice' || settings?.speakReplies })
        : await api.threads.create({ classId: study.classId, anchor, message, via, sessionId: study.sessionId, streamId, voice: via === 'voice' || settings?.speakReplies })
      setLocal(out)
      onThreadRef.current(out.id)
      afterReply(out)
    } catch (err) {
      toast(errorMessage(err), 'error')
      setDraft(message)
    } finally {
      setPending(null)
    }
  }

  async function moreHelp() {
    if (!shown || pending) return
    const streamId = newStreamId()
    streamRef.current = streamId
    setPending({ streamId, text: '' })
    try {
      const out = await api.threads.moreHelp({ classId: study.classId, threadId: shown.id, streamId, voice: viaVoice.current || settings?.speakReplies })
      setLocal(out)
      onThreadRef.current(out.id)
      afterReply(out)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setPending(null)
    }
  }

  function afterReply(t: Thread) {
    const last = t.messages[t.messages.length - 1]
    if (last?.role !== 'tutor' || last.error) return
    study.speakReply(last.text, last.id, viaVoice.current)
    // Diagram directives also apply when not speaking: point at the first part mentioned.
    if (!(viaVoice.current || settings?.speakReplies)) {
      const first = /\[\[highlight:([^\]]+)\]\]/.exec(last.text)
      if (first) study.handleDirective({ type: 'highlight', elementId: first[1].trim() })
    }
  }

  const sentInitial = useRef<string | null>(null)
  useEffect(() => {
    if (initialVoice && sentInitial.current !== initialVoice) {
      sentInitial.current = initialVoice
      void submit(initialVoice, 'voice')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialVoice])

  // Dictation goes into this thread while it is open.
  useEffect(() => {
    study.setVoiceSink(voiceOwner, (text) => {
      if (pending) {
        toast('The tutor is still answering. Ask again when it finishes.')
        return true
      }
      void submit(text, 'voice')
      return true
    })
    return () => study.setVoiceSink(voiceOwner, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOwner, shown?.id, pending])

  function onBodyMouseUp() {
    setTimeout(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setFollow(null)
      const range = sel.getRangeAt(0)
      const el = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>('[data-message-id]')
      const quote = sel.toString().replace(/\s+/g, ' ').trim()
      if (!el || !quote || !shown) return setFollow(null)
      const rect = range.getBoundingClientRect()
      setFollow({ messageId: el.dataset.messageId!, quote: quote.slice(0, 600), x: rect.left + rect.width / 2, y: rect.top })
    }, 0)
  }

  const lastMessage = shown?.messages[shown.messages.length - 1]
  const rung = shown?.rung ?? study.bundle.independence.defaultRung
  const lastTutor = [...(shown?.messages ?? [])].reverse().find((m) => m.role === 'tutor')
  const canMoreHelp = Boolean(shown && lastTutor && rung < 4 && !pending)

  return (
    <>
      <div className="thread-body" ref={bodyRef} onMouseUp={onBodyMouseUp} data-testid="thread-body">
        {!shown?.messages.length && !pending && suggestions && (
          <div className="chips" style={{ marginTop: 2 }}>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" style={{ cursor: 'pointer', border: 0, paddingRight: 10 }} onClick={() => void submit(s, 'text')}>
                {s}
              </button>
            ))}
          </div>
        )}
        {shown?.messages.map((m) => <Message key={m.id} m={m} />)}
        {pending?.user && !(lastMessage?.role === 'user' && lastMessage.text === pending.user) && <div className="msg user">{pending.user}</div>}
        {pending && (
          <div className="msg tutor" data-testid="tutor-streaming">
            {pending.text ? <Markdown text={pending.text} streaming sourceTitle={study.sourceTitle} onDirective={study.handleDirective} /> : <span className="muted small">Reading your materials…</span>}
          </div>
        )}
      </div>
      {follow && shown && (
        <button
          className="btn sm primary"
          style={{ position: 'fixed', left: follow.x, top: follow.y - 34, transform: 'translateX(-50%)', zIndex: 90 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const rect = new DOMRect(follow.x, follow.y, 0, 0)
            study.ask({ kind: 'message', threadId: shown.id, messageId: follow.messageId, quote: follow.quote }, rect)
            setFollow(null)
            window.getSelection()?.removeAllRanges()
          }}
          data-testid="ask-followup"
        >
          <Icon name="ask" size={13} /> Ask about this
        </button>
      )}
      <div className="rung-bar" data-testid="rung-bar">
        <span className="rung-steps" aria-hidden="true">
          {[1, 2, 3, 4].map((r) => (
            <i key={r} className={r <= rung ? 'on' : ''} />
          ))}
        </span>
        <span>
          Help: <b>{RUNG_LABELS[rung]}</b>
        </span>
        <span className="spacer" />
        <button className="btn ghost sm" disabled={!canMoreHelp} onClick={moreHelp} title="Climb one rung of the help ladder" data-testid="more-help">
          More help
        </button>
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(draft, 'text')
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={shown ? 'Reply… (hold Space outside the box to talk)' : 'Ask about this…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit(draft, 'text')
            }
          }}
          data-testid="ask-input"
        />
        {pending ? (
          <button type="button" className="btn sm icon" aria-label="Stop" onClick={() => void api.threads.cancel(pending.streamId)}>
            <Icon name="stop" size={13} />
          </button>
        ) : (
          <button className="btn primary sm icon" aria-label="Send" disabled={!draft.trim()} data-testid="ask-send">
            <Icon name="send" size={14} />
          </button>
        )}
      </form>
    </>
  )
}

function Message({ m }: { m: ThreadMessage }): JSX.Element {
  const study = useStudy()
  if (m.role === 'user') return <div className="msg user">{m.text}</div>
  return (
    <div className={`msg tutor ${m.error ? 'error' : ''}`} data-message-id={m.id} data-testid="tutor-message">
      {m.rung && (
        <div className="msg-meta">
          <Icon name="sparkle" size={11} /> {RUNG_LABELS[m.rung]}
        </div>
      )}
      <Markdown text={m.text} sourceTitle={study.sourceTitle} onDirective={study.handleDirective} />
    </div>
  )
}
