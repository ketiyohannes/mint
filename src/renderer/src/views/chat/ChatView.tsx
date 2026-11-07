import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { RUNG_LABELS, type ChatCommand, type ClassBundle, type Thread, type ThreadMessage } from '@shared/types'
import { api, errorMessage, newStreamId } from '../../lib/api'
import { useApp } from '../../state/app'
import { RichText } from '../../components/RichText'
import { Icon, type IconName } from '../../components/Icon'
import { useStudy } from '../study/context'
import { checkDraft } from '../study/drafts'
import { ChatCtx, type ChatApi } from './chatContext'
import { Composer, parseSlash, SLASH_COMMANDS } from './Composer'
import { quoteMessage, splitQuoted } from '@shared/quote'
import { Widget } from './Widget'

interface Pending {
  streamId: string
  user?: string
  text: string
  label: string
}


interface Props {
  bundle: ClassBundle
  thread: Thread | undefined
  /** The chat now exists (or was replaced): show it. */
  onThread: (threadId: string) => void
  onAddMaterials: () => void
  /** Tool requests from elsewhere (tutor offers, lesson buttons) to run in this chat. One-shot: call onHandled. */
  commandRequest: { command: ChatCommand; arg?: string; nonce: number } | null
  /** A highlighted passage to attach to the next message. One-shot: call onHandled. */
  quoteRequest: { text: string; source: string; nonce: number } | null
  onHandled: (kind: 'command' | 'quote') => void
}

/** The main chat: a conversation with the tutor in which tools post interactive widgets. */
/**
 * Mounted per chat (the parent remounts it when another chat is opened), so
 * in-flight state never leaks between chats.
 */
export function ChatView({ bundle, thread, onThread, onAddMaterials, commandRequest, quoteRequest, onHandled }: Props): JSX.Element {
  const { toast, jobs, settings } = useApp()
  /** Coach style shows the help ladder (rung tags, More help); Teach always explains in full. */
  const ladder = settings?.tutorStyle === 'coach'
  const study = useStudy()
  const classId = bundle.meta.id
  const [pending, setPending] = useState<Pending | null>(null)
  const [local, setLocal] = useState<Thread | undefined>(thread)
  const [follow, setFollow] = useState<{ messageId: string; quote: string; x: number; y: number } | null>(null)
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null)
  const [quote, setQuote] = useState<{ text: string; source: string } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const onThreadRef = useRef(onThread)
  onThreadRef.current = onThread
  /** The chat this view shows (or created itself). */
  const adopted = useRef<string | null>(thread?.id ?? null)

  // Prefer the freshest copy: the live bundle once it has caught up with our own result.
  const shown = useMemo(() => {
    if (!thread) return local
    if (!local || local.id !== thread.id) return thread
    return thread.updatedAt >= local.updatedAt ? thread : local
  }, [thread, local])

  const adopt = useCallback((t: Thread) => {
    adopted.current = t.id
    setLocal(t)
    onThreadRef.current(t.id)
  }, [])

  // One stream subscription for the view's lifetime.
  const streamRef = useRef<string | null>(null)
  /** The learner pressed stop: the call ends as cancelled, which is not an error to report. */
  const stopRequested = useRef(false)
  useEffect(
    () =>
      api.on.stream((e) => {
        if (!streamRef.current || e.streamId !== streamRef.current) return
        if (e.threadId && e.threadId !== adopted.current) {
          adopted.current = e.threadId
          onThreadRef.current(e.threadId)
        }
        if (e.delta) setPending((p) => (p && p.streamId === e.streamId ? { ...p, text: p.text + e.delta } : p))
      }),
    []
  )

  useEffect(() => {
    const el = bodyRef.current
    if (el && stickToBottom.current) el.scrollTo({ top: el.scrollHeight })
  }, [shown?.messages.length, pending?.text, pending?.user])

  /** Run a call that may stream a tutor message into this chat. */
  const run = useCallback(
    async (label: string, user: string | undefined, task: (streamId: string) => Promise<Thread>) => {
      if (pending) return
      const streamId = newStreamId()
      streamRef.current = streamId
      stopRequested.current = false
      stickToBottom.current = true
      setPending({ streamId, user, text: '', label })
      try {
        const out = await task(streamId)
        adopt(out)
      } catch (err) {
        if (!stopRequested.current) toast(errorMessage(err), 'error')
        if (user && !user.startsWith('/')) setPrefill({ text: user, nonce: Date.now() })
      } finally {
        streamRef.current = null
        setPending(null)
      }
    },
    [pending, adopt, toast]
  )

  const submit = useCallback(
    (input: string) => {
      const attached = quote
      setQuote(null)
      const slash = parseSlash(input)
      if (slash) {
        // A tool on a quoted passage focuses on that passage.
        const arg = slash.arg || (attached ? `"${attached.text.slice(0, 400)}"` : '')
        const call = `/${slash.command}${arg ? ` ${arg}` : ''}`
        void run(TOOL_LABEL[slash.command], call, (streamId) => api.chat.command({ classId, threadId: shown?.id, command: slash.command, arg, streamId }))
        return
      }
      const text = attached ? quoteMessage(attached.text, attached.source, input || 'Can you help me understand this passage?') : input
      // In a lesson chat, the tutor also sees the answer being written in the study box.
      const studyDraft = checkDraft(shown?.sessionId)
      void run('Thinking', text, (streamId) => api.chat.send({ classId, threadId: shown?.id, message: text, streamId, studyDraft }))
    },
    [run, classId, shown?.id, shown?.sessionId, quote]
  )

  const command = useCallback(
    (cmd: ChatCommand, arg?: string) => {
      void run(TOOL_LABEL[cmd], `/${cmd}${arg ? ` ${arg}` : ''}`, (streamId) => api.chat.command({ classId, threadId: shown?.id, command: cmd, arg, streamId }))
    },
    [run, classId, shown?.id]
  )

  // Requests from outside the chat (offer chips, lesson buttons, quotes). Each runs once.
  const handled = useRef(new Set<number>())
  useEffect(() => {
    if (!commandRequest || handled.current.has(commandRequest.nonce) || pending) return
    handled.current.add(commandRequest.nonce)
    onHandled('command')
    command(commandRequest.command, commandRequest.arg)
  }, [commandRequest, command, onHandled, pending])
  useEffect(() => {
    if (!quoteRequest || handled.current.has(quoteRequest.nonce)) return
    handled.current.add(quoteRequest.nonce)
    onHandled('quote')
    setQuote({ text: quoteRequest.text, source: quoteRequest.source })
  }, [quoteRequest, onHandled])

  const moreHelp = () => {
    if (!shown) return
    void run('More help', undefined, (streamId) => api.threads.moreHelp({ classId, threadId: shown.id, streamId, studyDraft: checkDraft(shown.sessionId) }))
  }

  const chatApi = useMemo<ChatApi>(
    () => ({
      threadId: shown?.id ?? '',
      busy: Boolean(pending),
      stream: (task) => run('Reviewing your code', undefined, task)
    }),
    [shown?.id, pending, run]
  )

  function onBodyMouseUp() {
    setTimeout(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setFollow(null)
      const range = sel.getRangeAt(0)
      const node = range.commonAncestorContainer
      const el = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-message-id]')
      const quote = sel.toString().replace(/\s+/g, ' ').trim()
      if (!el || !quote || !shown) return setFollow(null)
      const rect = range.getBoundingClientRect()
      setFollow({ messageId: el.dataset.messageId!, quote: quote.slice(0, 600), x: rect.left + rect.width / 2, y: rect.top })
    }, 0)
  }

  const messages = shown?.messages ?? []
  const lastTutor = [...messages].reverse().find((m) => m.role === 'tutor')
  const rung = shown?.rung ?? bundle.independence.defaultRung
  const canMoreHelp = Boolean(ladder && shown && shown.anchor.kind === 'general' && lastTutor?.rung && !lastTutor.widget && rung < 4 && !pending)
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const showPendingUser = pending?.user && !(lastUser?.text === pending.user && messages[messages.length - 1] === lastUser)
  const empty = !messages.length && !pending
  const job = jobs.filter((j) => j.classId === classId).at(-1)

  const composer = (
    <Composer
      onSubmit={submit}
      busy={Boolean(pending)}
      onStop={
        pending
          ? () => {
              stopRequested.current = true
              void api.threads.cancel(pending.streamId)
            }
          : undefined
      }
      placeholder={empty ? (bundle.meta.stage === 'intake' ? 'What do you want to learn from this?' : 'Ask anything, or type / for tools') : 'Reply…  (/ for tools)'}
      centered={empty}
      autoFocus
      onAddMaterials={onAddMaterials}
      prefill={prefill}
      quote={quote}
      onClearQuote={() => setQuote(null)}
    />
  )

  return (
    <ChatCtx.Provider value={chatApi}>
      {empty ? (
        <div className="chat-hero" data-testid="chat-hero">
          <div className="hero-inner">
            <h1 className="hero-title">{bundle.meta.stage === 'intake' ? 'What do you want to learn?' : bundle.meta.title}</h1>
            <div className="hero-sub">
              {bundle.sources.length ? (
                <span>
                  <Icon name="folderOpen" size={13} /> {bundle.meta.title} · {bundle.sources.length} source{bundle.sources.length === 1 ? '' : 's'}
                </span>
              ) : (
                <span>No materials yet: I will find trusted sources, or add your own.</span>
              )}
              {job && (
                <span className="hero-job">
                  <span className="spinner tiny" /> {job.label}…
                </span>
              )}
            </div>
            {composer}
            <div className="hero-chips">
              {(bundle.meta.stage === 'intake'
                ? ['I want to understand this deeply', 'I have an exam coming up', 'I need this for a project at work']
                : ['/lesson', '/quiz', 'Explain the main idea in plain words', '/code']
              ).map((s) => (
                <button key={s} className="hero-chip" onClick={() => submit(s)} data-testid="hero-chip">
                  {s.startsWith('/') && <Icon name={commandIcon(s)} size={13} />}
                  {s.startsWith('/') ? TOOL_CHIP[s] : s}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="chat-body" ref={bodyRef} onMouseUp={onBodyMouseUp} onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }} data-testid="chat-body">
            <div className="chat-col">
              {messages.map((m) => (
                <MessageView key={m.id} m={m} isLast={m === lastTutor} ladder={ladder} canMoreHelp={canMoreHelp && m === lastTutor} onMoreHelp={moreHelp} />
              ))}
              {showPendingUser && <UserMessage text={pending!.user!} />}
              {pending && (
                <div className="msg tutor" data-testid="tutor-streaming">
                  {pending.text ? (
                    <RichText text={pending.text} streaming />
                  ) : (
                    <div className="thinking">
                      <span className="spinner tiny" /> {job?.label ?? pending.label}…
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="chat-foot">
            <div className="chat-col">{composer}</div>
          </div>
        </>
      )}
      {follow && shown && (
        <div className="sel-toolbar floating-ask" style={{ left: follow.x, top: follow.y - 6 }} onMouseDown={(e) => e.preventDefault()}>
          <button
            onClick={() => {
              setQuote({ text: follow.quote, source: 'Tutor' })
              setFollow(null)
              window.getSelection()?.removeAllRanges()
            }}
            data-testid="quote-in-chat"
          >
            <Icon name="chat" size={14} /> Chat
          </button>
          <button
            onClick={() => {
              study.ask({ kind: 'message', threadId: shown.id, messageId: follow.messageId, quote: follow.quote }, new DOMRect(follow.x, follow.y, 0, 0))
              setFollow(null)
              window.getSelection()?.removeAllRanges()
            }}
            data-testid="ask-followup"
          >
            <Icon name="ask" size={14} /> Side chat
          </button>
        </div>
      )}
    </ChatCtx.Provider>
  )
}

const TOOL_LABEL: Record<ChatCommand, string> = {
  quiz: 'Writing a quiz',
  code: 'Writing a code exercise',
  diagram: 'Drawing a diagram',
  lesson: 'Preparing the lesson',
  plan: 'Re-planning'
}

const TOOL_CHIP: Record<string, string> = { '/lesson': 'Start the next lesson', '/quiz': 'Quiz me', '/code': 'Give me a code exercise' }

function commandIcon(text: string): IconName {
  const slash = parseSlash(text)
  return SLASH_COMMANDS.find((c) => c.command === slash?.command)?.icon ?? 'sparkle'
}

function UserMessage({ text }: { text: string }): JSX.Element {
  const slash = parseSlash(text)
  if (slash)
    return (
      <div className="tool-call" data-testid="tool-call">
        <Icon name={commandIcon(text)} size={13} /> <b>/{slash.command}</b> {slash.arg && <span className="muted">{slash.arg}</span>}
      </div>
    )
  const { quote, source, body } = splitQuoted(text)
  if (quote)
    return (
      <div className="msg user quoted" data-testid="user-message">
        <blockquote className="user-quote">
          <span>{quote}</span>
          {source && <cite>{source}</cite>}
        </blockquote>
        {body}
      </div>
    )
  return (
    <div className="msg user" data-testid="user-message">
      {text}
    </div>
  )
}

function MessageView({ m, isLast, ladder, canMoreHelp, onMoreHelp }: { m: ThreadMessage; isLast: boolean; ladder: boolean; canMoreHelp: boolean; onMoreHelp: () => void }): JSX.Element {
  if (m.role === 'user') return <UserMessage text={m.text} />
  return (
    <div className={`msg tutor ${m.error ? 'error' : ''}`} data-message-id={m.id} data-testid="tutor-message">
      {m.text && <RichText text={m.text} />}
      {m.widget && <Widget message={m} />}
      {m.text && !m.error && (
        <div className={`msg-actions ${isLast ? 'last' : ''}`}>
          <button className="icon-btn" title="Copy" aria-label="Copy reply" onClick={() => void navigator.clipboard.writeText(m.text)}>
            <Icon name="copy" size={14} />
          </button>
          {ladder && m.rung && !m.widget && (
            <span className="rung-tag" title="Help ladder: the tutor gives as little help as you need">
              {RUNG_LABELS[m.rung]}
            </span>
          )}
          {isLast && canMoreHelp && (
            <button className="link-btn" onClick={onMoreHelp} data-testid="more-help">
              <Icon name="lifebuoy" size={13} /> More help
            </button>
          )}
        </div>
      )}
    </div>
  )
}
