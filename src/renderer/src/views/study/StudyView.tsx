import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Anchor, Annotation, ClassBundle, Explorable, Thread } from '@shared/types'
import type { Directive } from '@shared/directives'
import { useApp, type ClassTab } from '../../state/app'
import { useSourceDoc } from '../../state/useClass'
import { api } from '../../lib/api'
import type { SelectionAnchor } from '../../lib/anchors'
import { Icon, type IconName } from '../../components/Icon'
import { Activity } from '../../components/Activity'
import { Reader, type ReaderFocus } from './Reader'
import { AskPopover, NotePopover, SelectionToolbar, TermPopover, placeNear, type AskState } from './Popovers'
import { ThreadView } from './ThreadView'
import { SessionPanel } from './SessionPanel'
import { DiagramPanel } from './DiagramPanel'
import { StudyCtx, type StudyApi, type VoiceSink } from './context'
import { useVoice } from './useVoice'

type Side = 'session' | 'ask' | 'diagram' | 'stickies'

const TABS: { id: ClassTab; label: string; icon: IconName }[] = [
  { id: 'path', label: 'Path', icon: 'path' },
  { id: 'study', label: 'Study', icon: 'book' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'notebook', label: 'Notebook', icon: 'notebook' },
  { id: 'progress', label: 'Progress', icon: 'chart' }
]

/**
 * Study: the reader fills the screen, and the tutor lives in the margin, in
 * floating Ask popovers, and in the side panel (session, ask, diagrams, stickies).
 */
export function StudyView({ bundle, onTab }: { bundle: ClassBundle; onTab: (t: ClassTab) => void }): JSX.Element {
  const { settings, toast, run, studyFocus, setSettings } = useApp()
  const classId = bundle.meta.id
  const session = useMemo(() => [...bundle.sessions].reverse().find((s) => !s.endedAt), [bundle.sessions])

  // --- sources -----------------------------------------------------------
  const [activeSourceId, setActiveSourceId] = useState<string | null>(() => session?.brief?.readings[0]?.sourceId ?? bundle.sources[0]?.id ?? null)
  const [openTabs, setOpenTabs] = useState<string[]>(() => (activeSourceId ? [activeSourceId] : []))
  const [focus, setFocus] = useState<ReaderFocus | null>(null)
  const activeMeta = bundle.sources.find((s) => s.id === activeSourceId)
  const { doc, error: docError } = useSourceDoc(classId, activeMeta ? activeSourceId : null, activeMeta ? `${activeMeta.wordCount}:${activeMeta.needsTranscript}` : undefined)

  const openSource = useCallback((sourceId: string, section?: string, quote?: string) => {
    setActiveSourceId(sourceId)
    setOpenTabs((t) => (t.includes(sourceId) ? t : [...t, sourceId]))
    setFocus({ section, quote, nonce: Date.now() })
  }, [])

  // Jumps requested from other tabs (Path links, Notebook stickies).
  const lastFocus = useRef<number>(0)
  useEffect(() => {
    if (studyFocus && studyFocus.nonce !== lastFocus.current) {
      lastFocus.current = studyFocus.nonce
      if (bundle.sources.some((s) => s.id === studyFocus.sourceId)) openSource(studyFocus.sourceId, studyFocus.section, studyFocus.quote)
    }
  }, [studyFocus, bundle.sources, openSource])

  // When a session starts, open its first reading once.
  const openedFor = useRef<string | null>(null)
  useEffect(() => {
    const r = session?.brief?.readings[0]
    if (session && r && openedFor.current !== session.id && !studyFocus) {
      openedFor.current = session.id
      openSource(r.sourceId, r.section)
    }
  }, [session, openSource, studyFocus])

  // Drop tabs for removed sources.
  useEffect(() => {
    setOpenTabs((t) => t.filter((id) => bundle.sources.some((s) => s.id === id)))
    if (activeSourceId && !bundle.sources.some((s) => s.id === activeSourceId)) setActiveSourceId(bundle.sources[0]?.id ?? null)
  }, [bundle.sources, activeSourceId])

  // --- side panel, popovers ------------------------------------------------
  const [side, setSide] = useState<Side>(session ? 'session' : 'ask')
  useEffect(() => {
    if (session) setSide((s) => (s === 'ask' || s === 'stickies' ? 'session' : s))
  }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const [selection, setSelection] = useState<(SelectionAnchor & { sourceId: string }) | null>(null)
  const [ask, setAsk] = useState<AskState | null>(null)
  const [sideThread, setSideThread] = useState<{ anchor: Anchor; threadId?: string; initialVoice?: string; key: number } | null>(null)
  const [note, setNote] = useState<{ annotation: Annotation; pos: { x: number; y: number } } | null>(null)
  const [term, setTerm] = useState<{ anchor: Extract<Anchor, { kind: 'source' }>; pos: { x: number; y: number } } | null>(null)
  const [hidePins, setHidePins] = useState(false)

  // --- diagrams --------------------------------------------------------------
  const [explorableId, setExplorableId] = useState<string | null>(null)
  const explorable = bundle.explorables.find((e) => e.id === explorableId) ?? null
  const [highlight, setHighlight] = useState<string[]>([])
  const [params, setParams] = useState<Record<string, number>>({})
  const paramsFor = useRef<string | null>(null)
  useEffect(() => {
    const key = explorable ? `${explorable.id}:${explorable.repairs}` : null
    if (key !== paramsFor.current) {
      paramsFor.current = key
      setParams(Object.fromEntries(explorable?.spec.params.map((p) => [p.id, p.value]) ?? []))
      setHighlight([])
    }
  }, [explorable])

  const openDiagram = useCallback((e: Explorable) => {
    setExplorableId(e.id)
    setSide('diagram')
  }, [])

  // --- directives (citations, diagram pointing) ------------------------------
  const handleDirective = useCallback(
    (d: Directive) => {
      if (d.type === 'cite') {
        if (bundle.sources.some((s) => s.id === d.sourceId)) openSource(d.sourceId, d.section, d.quote)
        else toast('That citation points to a source that is no longer in this class.', 'error')
        return
      }
      // Diagram directives target the diagram being discussed.
      const targetId = ask?.anchor.kind === 'diagram' ? ask.anchor.explorableId : explorableId
      const target = bundle.explorables.find((x) => x.id === targetId)
      if (!target) return
      if (targetId !== explorableId) setExplorableId(target.id)
      setSide('diagram')
      if (d.type === 'highlight') setHighlight([d.elementId])
      else {
        const p = target.spec.params.find((x) => x.id === d.paramId)
        if (p) setParams((v) => ({ ...v, [p.id]: Math.min(p.max, Math.max(p.min, d.value)) }))
      }
    },
    [bundle.sources, bundle.explorables, openSource, toast, ask, explorableId]
  )

  // --- voice ---------------------------------------------------------------
  const sinks = useRef(new Map<string, VoiceSink>())
  const setVoiceSink = useCallback((owner: string, sink: VoiceSink | null) => {
    if (sink) sinks.current.set(owner, sink)
    else sinks.current.delete(owner)
  }, [])

  const onTranscript = useCallback(
    (text: string) => {
      // Priority: the open Ask popover, then the side thread, then a check answer.
      for (const owner of ['popover', 'side', 'check']) {
        const sink = sinks.current.get(owner)
        if (sink && sink(text)) return
      }
      // Otherwise start a general question in the side panel.
      setSide('ask')
      setSideThread({ anchor: { kind: 'general', context: doc ? `Reading "${doc.title}"` : undefined }, initialVoice: text, key: Date.now() })
    },
    [doc]
  )

  const voice = useVoice({ settings, onTranscript, onDirective: handleDirective, onError: (m) => toast(m, 'error') })

  const speakReply = useCallback(
    (text: string, messageId: string, force?: boolean) => {
      if (force || settings?.speakReplies) voice.say(text, messageId)
    },
    [settings?.speakReplies, voice]
  )

  // --- ask -------------------------------------------------------------------
  const threadsById = useMemo(() => new Map(bundle.threads.map((t) => [t.id, t])), [bundle.threads])
  const askRef = useRef(ask)
  askRef.current = ask
  const threadsRef = useRef(threadsById)
  threadsRef.current = threadsById

  /** Keep a conversation the learner moves away from as a sticky in the margin. */
  const pinIfNeeded = useCallback(
    (threadId: string | undefined) => {
      if (!threadId) return
      const t = threadsRef.current.get(threadId)
      if (t && !t.pinned) void api.threads.setPinned(classId, t.id, true).catch(() => undefined)
    },
    [classId]
  )

  const askAt = useCallback(
    (anchor: Anchor, rect?: DOMRect, threadId?: string) => {
      setSelection(null)
      const prev = askRef.current
      if (prev?.threadId && prev.threadId !== threadId) pinIfNeeded(prev.threadId)
      setAsk({ key: Date.now(), anchor, threadId, pos: placeNear(rect) })
    },
    [pinIfNeeded]
  )

  const minimizeAsk = useCallback(() => {
    pinIfNeeded(askRef.current?.threadId)
    setAsk(null)
  }, [pinIfNeeded])

  const studyApi: StudyApi = {
    bundle,
    classId,
    sessionId: session?.id,
    sourceTitle: (id) => bundle.sources.find((s) => s.id === id)?.title,
    handleDirective,
    ask: askAt,
    speakReply,
    setVoiceSink,
    openDiagram,
    activeExplorableId: explorableId
  }

  // --- selection actions ---------------------------------------------------
  const sourceAnchor = (sel: SelectionAnchor & { sourceId: string }): Extract<Anchor, { kind: 'source' }> => ({
    kind: 'source',
    sourceId: sel.sourceId,
    sectionLabel: sel.sectionLabel,
    ranges: sel.ranges,
    quote: sel.quote
  })

  const clearSelection = () => {
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  const onSelection = useCallback(
    (a: SelectionAnchor | null) => {
      if (!a || !activeSourceId) return setSelection(null)
      setSelection({ ...a, sourceId: activeSourceId })
    },
    [activeSourceId]
  )

  const stickies = useMemo(
    () => ({
      threads: bundle.threads.filter((t) => t.pinned).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      notes: bundle.annotations.filter((a) => a.kind === 'note')
    }),
    [bundle.threads, bundle.annotations]
  )

  const sideTabs: { id: Side; label: string; icon: IconName; show: boolean }[] = [
    { id: 'session', label: 'Session', icon: 'target', show: Boolean(session) },
    { id: 'ask', label: 'Ask', icon: 'ask', show: true },
    { id: 'diagram', label: 'Diagram', icon: 'diagram', show: true },
    { id: 'stickies', label: `Stickies${stickies.threads.length + stickies.notes.length ? ` ${stickies.threads.length + stickies.notes.length}` : ''}`, icon: 'pin', show: true }
  ]

  return (
    <StudyCtx.Provider value={studyApi}>
      <div className="row" style={{ padding: '6px 14px', borderBottom: '1px solid var(--border)', gap: 4 }}>
        {TABS.map((t) => (
          <button key={t.id} className={`class-tab ${t.id === 'study' ? 'active' : ''}`} style={{ padding: '6px 10px' }} onClick={() => onTab(t.id)} data-testid={`tab-${t.id}`}>
            <Icon name={t.icon} size={14} /> {t.label}
          </button>
        ))}
        <span className="spacer" />
        <Activity classId={classId} />
      </div>
      <div className={`study ${side === 'diagram' ? 'wide-side' : ''}`} style={{ position: 'relative' }}>
        <div className="reader-wrap">
          <div className="reader-toolbar">
            {openTabs.map((id) => {
              const s = bundle.sources.find((x) => x.id === id)
              if (!s) return null
              return (
                <button key={id} className={`tab source-tab ${id === activeSourceId ? 'active' : ''}`} onClick={() => setActiveSourceId(id)} title={s.title}>
                  {s.title}
                </button>
              )
            })}
            <select
              className="select"
              style={{ width: 'auto', maxWidth: 200, height: 30, padding: '2px 8px' }}
              value=""
              onChange={(e) => e.target.value && openSource(e.target.value)}
              aria-label="Open a source"
              data-testid="open-source"
            >
              <option value="">Open source…</option>
              {bundle.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => setHidePins((h) => !h)} title="Show or hide stickies in the margin" data-testid="toggle-pins">
              <Icon name={hidePins ? 'eyeOff' : 'eye'} size={14} /> {hidePins ? 'Stickies hidden' : 'Stickies'}
            </button>
          </div>
          {!activeMeta ? (
            <div className="empty">
              <h3>No source open</h3>
              <p>Add materials in the Library, then open one here.</p>
              <button className="btn" onClick={() => onTab('library')}>
                Go to Library
              </button>
            </div>
          ) : docError ? (
            <div className="empty">{docError}</div>
          ) : !doc ? (
            <div className="empty">
              <span className="spinner" />
            </div>
          ) : (
            <Reader
              doc={doc}
              annotations={bundle.annotations}
              threads={bundle.threads}
              focus={focus}
              hidePins={hidePins}
              openThreadId={ask?.threadId ?? null}
              onSelection={onSelection}
              onOpenThread={(t, rect) => askAt(t.anchor, rect, t.id)}
              onOpenNote={(a, rect) => setNote({ annotation: a, pos: placeNear(rect) })}
            />
          )}
        <div className="voice-bar" data-testid="voice-bar">
            <button
              className={`mic ${voice.status === 'recording' ? 'rec' : voice.status === 'transcribing' ? 'busy' : ''}`}
              onClick={voice.toggle}
              aria-label={voice.status === 'recording' ? 'Stop recording' : 'Talk to the tutor'}
              title="Click, or hold Space, to talk"
              data-testid="mic"
            >
              {voice.status === 'transcribing' ? <span className="spinner" /> : <Icon name="mic" size={17} />}
            </button>
            <span className={`caption ${voice.caption ? 'speaking' : ''}`} data-testid="caption">
              {voice.status === 'recording'
                ? 'Listening… release Space (or click) when you are done.'
                : voice.status === 'transcribing'
                  ? voice.modelPct !== null
                    ? `Downloading the local speech model (${Math.round(voice.modelPct)}%)…`
                    : 'Transcribing…'
                  : voice.caption
                    ? voice.caption.text
                    : 'Hold Space to ask out loud'}
            </span>
            {voice.caption && (
              <button
                className="btn ghost sm"
                onClick={() => {
                  const c = voice.caption!
                  const owner = bundle.threads.find((t) => t.messages.some((m) => m.id === c.messageId))
                  if (owner) askAt({ kind: 'message', threadId: owner.id, messageId: c.messageId, quote: c.text })
                }}
                title="Ask about what the tutor just said"
              >
                <Icon name="ask" size={13} /> Ask
              </button>
            )}
            {voice.status === 'speaking' && (
              <button className="btn ghost sm icon" aria-label="Stop speaking" onClick={voice.stopSpeaking}>
                <Icon name="stop" size={13} />
              </button>
            )}
            <button
              className="btn ghost sm icon"
              title={settings?.speakReplies ? 'Spoken replies on' : 'Spoken replies off'}
              aria-label="Toggle spoken replies"
              onClick={async () => {
                const s = await run(() => api.settings.update({ speakReplies: !settings?.speakReplies }))
                if (s) setSettings(s)
              }}
              data-testid="toggle-speech"
            >
              <Icon name={settings?.speakReplies ? 'volume' : 'volumeOff'} size={15} />
            </button>
          </div>
        </div>

        <aside className="side">
          <div className="side-tabs">
            <div className="tabs">
              {sideTabs
                .filter((t) => t.show)
                .map((t) => (
                  <button key={t.id} className={`tab ${side === t.id ? 'active' : ''}`} onClick={() => setSide(t.id)} data-testid={`side-${t.id}`}>
                    <Icon name={t.icon} size={13} /> {t.label}
                  </button>
                ))}
            </div>
          </div>
          <div className="side-body" style={side === 'ask' ? { padding: 0, display: 'flex', flexDirection: 'column' } : undefined}>
            {side === 'session' && session && <SessionPanel session={session} onOpenReading={(sid, sec) => openSource(sid, sec)} onDone={() => onTab('path')} />}
            {side === 'ask' &&
              (sideThread ? (
                <>
                  <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
                    <span className="small muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sideThread.anchor.kind === 'source' || sideThread.anchor.kind === 'message' ? `“${sideThread.anchor.quote}”` : 'General question'}
                    </span>
                    <button className="btn ghost sm" onClick={() => setSideThread({ anchor: { kind: 'general' }, key: Date.now() })}>
                      <Icon name="plus" size={13} /> New
                    </button>
                  </div>
                  <ThreadView
                    key={sideThread.key}
                    anchor={sideThread.anchor}
                    thread={sideThread.threadId ? threadsById.get(sideThread.threadId) : undefined}
                    onThread={(t: Thread) => setSideThread((s) => (s ? { ...s, threadId: t.id, initialVoice: undefined } : s))}
                    voiceOwner="side"
                    initialVoice={sideThread.initialVoice}
                    suggestions={false}
                  />
                </>
              ) : (
                <div style={{ padding: 16 }}>
                  <div className="empty small" style={{ padding: '24px 8px' }}>
                    <h3>Ask as you read</h3>
                    Select any passage and press <b>Ask</b>, or hold <span className="kbd">Space</span> and talk. Answers point back to the page they come from, and help starts
                    small: ask for more when you need it.
                  </div>
                  <button className="btn" onClick={() => setSideThread({ anchor: { kind: 'general' }, key: Date.now() })} data-testid="general-ask">
                    <Icon name="ask" size={14} /> Ask a general question
                  </button>
                </div>
              ))}
            {side === 'diagram' && (
              <DiagramPanel explorable={explorable} highlight={highlight} params={params} onParams={setParams} onHighlight={setHighlight} onSelect={(e) => setExplorableId(e?.id ?? null)} />
            )}
            {side === 'stickies' && (
              <div className="stack" style={{ gap: 8 }}>
                {!stickies.threads.length && !stickies.notes.length && <div className="empty small">Pinned Ask threads and your sticky notes show up here and in the margin.</div>}
                {stickies.threads.map((t) => (
                  <button
                    key={t.id}
                    className="list-item"
                    onClick={() => {
                      if (t.anchor.kind === 'source') openSource(t.anchor.sourceId, t.anchor.sectionLabel, t.anchor.quote)
                      if (t.anchor.kind === 'diagram') {
                        const e = bundle.explorables.find((x) => x.id === (t.anchor as Extract<Anchor, { kind: 'diagram' }>).explorableId)
                        if (e) openDiagram(e)
                      }
                      askAt(t.anchor, undefined, t.id)
                    }}
                    data-testid="sticky-thread"
                  >
                    <span className="pin q" style={{ flex: 'none' }}>
                      ?
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                      <div className="small muted">
                        {t.messages.length} message{t.messages.length === 1 ? '' : 's'}
                        {t.anchor.kind === 'source' ? ` · ${bundle.sources.find((s) => s.id === (t.anchor as Extract<Anchor, { kind: 'source' }>).sourceId)?.title ?? ''}` : ''}
                      </div>
                    </div>
                  </button>
                ))}
                {stickies.notes.map((n) => (
                  <button key={n.id} className="list-item" onClick={() => openSource(n.anchor.sourceId, n.anchor.sectionLabel, n.anchor.quote)}>
                    <span className="pin n" style={{ flex: 'none' }}>
                      ✎
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{n.text || '(empty note)'}</div>
                      <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        “{n.anchor.quote}”
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

      </div>

      {selection && !ask && (
        <SelectionToolbar
          rect={selection.rect}
          onAsk={() => {
            askAt(sourceAnchor(selection), selection.rect)
          }}
          onNote={async () => {
            const anchor = sourceAnchor(selection)
            const rect = selection.rect
            clearSelection()
            await run(() => api.annotations.create(classId, anchor, 'note', ''))
            // Open the new note for writing once it exists.
            const fresh = await api.classes.get(classId)
            const created = [...fresh.annotations].reverse().find((a) => a.kind === 'note' && a.anchor.quote === anchor.quote)
            if (created) setNote({ annotation: created, pos: placeNear(rect) })
          }}
          onHighlight={() => {
            const anchor = sourceAnchor(selection)
            clearSelection()
            void run(() => api.annotations.create(classId, anchor, 'highlight'))
          }}
          onDiagram={async () => {
            const anchor = sourceAnchor(selection)
            clearSelection()
            setSide('diagram')
            const e = await run(() => api.diagrams.create(classId, `Make an interactive diagram that helps me understand: "${anchor.quote.slice(0, 400)}"`, anchor))
            if (e) openDiagram(e)
          }}
          onTerm={() => {
            const anchor = sourceAnchor(selection)
            setTerm({ anchor, pos: placeNear(selection.rect) })
            clearSelection()
          }}
        />
      )}

      {ask && (
        <AskPopover
          key={ask.key}
          state={ask}
          thread={ask.threadId ? threadsById.get(ask.threadId) : undefined}
          onMove={(pos) => setAsk((a) => (a ? { ...a, pos } : a))}
          onMinimize={minimizeAsk}
          onClose={() => setAsk(null)}
          onExpand={() => {
            setSideThread({ anchor: ask.anchor, threadId: ask.threadId, key: Date.now() })
            setSide('ask')
            setAsk(null)
          }}
          onThread={(t) => setAsk((a) => (a ? { ...a, threadId: t.id } : a))}
        />
      )}
      {note && <NotePopover annotation={note.annotation} pos={note.pos} onMove={(pos) => setNote((n) => (n ? { ...n, pos } : n))} onClose={() => setNote(null)} />}
      {term && <TermPopover anchor={term.anchor} pos={term.pos} onMove={(pos) => setTerm((t) => (t ? { ...t, pos } : t))} onClose={() => setTerm(null)} />}
    </StudyCtx.Provider>
  )
}
