import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Anchor, Annotation, ChatCommand, ClassBundle, Thread } from '@shared/types'
import type { Directive } from '@shared/directives'
import { useApp } from '../state/app'
import { useSourceDoc } from '../state/useClass'
import { api } from '../lib/api'
import type { SelectionAnchor } from '../lib/anchors'
import { Icon, type IconName } from '../components/Icon'
import { Activity } from '../components/Activity'
import { KIND_ICON } from '../components/Sidebar'
import { Reader, type ReaderFocus } from './study/Reader'
import { PdfView } from './study/PdfView'
import { AskPopover, NotePopover, SelectionToolbar, TermPopover, placeNear, type AskState } from './study/Popovers'
import { StudyCtx, type DiagramController, type StudyApi } from './study/context'
import { ChatView } from './chat/ChatView'
import { LessonsPanel } from './LessonsPanel'
import { BrowserPanel } from './BrowserPanel'
import { NotesPanel } from './notes/NotesPanel'
import { ErrorBoundary } from '../components/ErrorBoundary'

type PanelTab = 'sources' | 'lessons' | 'browser' | 'notes'

interface SplitState {
  /** The second tab, or null when the panel shows one tab. */
  tab: PanelTab | null
  /** row: side by side; col: stacked. */
  dir: 'row' | 'col'
  /** Share of the panel given to the first tab (0.2 to 0.8). */
  ratio: number
}

const SPLIT_KEY = 'mint.split'
const PANEL_TAB_IDS: PanelTab[] = ['sources', 'lessons', 'browser', 'notes']

function loadSplit(): SplitState {
  try {
    const raw = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null') as Partial<SplitState> | null
    return {
      tab: raw?.tab && PANEL_TAB_IDS.includes(raw.tab) ? raw.tab : null,
      dir: raw?.dir === 'col' ? 'col' : 'row',
      ratio: typeof raw?.ratio === 'number' && raw.ratio >= 0.2 && raw.ratio <= 0.8 ? raw.ratio : 0.5
    }
  } catch {
    return { tab: null, dir: 'row', ratio: 0.5 }
  }
}

const PANEL_TABS: { id: PanelTab; label: string; icon: IconName }[] = [
  { id: 'sources', label: 'Sources', icon: 'book' },
  { id: 'lessons', label: 'Lessons', icon: 'lesson' },
  { id: 'browser', label: 'Browser', icon: 'globe' },
  { id: 'notes', label: 'Notes', icon: 'notebook' }
]

const PANEL_W_KEY = 'mint.panelWidth'
const SWAP_KEY = 'mint.swapped'
const MIN_PANEL = 340
const MIN_CHAT = 420

/**
 * A class, like a project in a coding agent: the chat with the tutor, and a
 * panel with your sources, lessons, a browser for your own research, and notes.
 * The chat and the panel can swap sides.
 */
export function Workspace({ bundle, chatId }: { bundle: ClassBundle; chatId: string | null | undefined }): JSX.Element {
  const { toast, run, studyFocus, go, classes } = useApp()
  const classId = bundle.meta.id

  // --- chats ---------------------------------------------------------------------
  const chats = useMemo(() => bundle.threads.filter((t) => t.anchor.kind === 'general').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [bundle.threads])
  // The chat view remounts when another chat is opened, but not when a chat it
  // just created becomes the route (that would drop the streaming reply).
  const adoptedChat = useRef<string | null>(null)

  // Opening a class shows its latest chat (or the new-chat prompt). A chat that
  // was deleted falls back to a new one; a chat just created may not be in the
  // bundle yet, so it is left alone.
  useEffect(() => {
    if (chatId === undefined) go({ name: 'class', classId, chatId: chats[0]?.id ?? null })
    else if (chatId && chatId !== adoptedChat.current && !bundle.threads.some((t) => t.id === chatId)) go({ name: 'class', classId, chatId: null })
  }, [chatId, chats, bundle.threads, classId, go])
  const thread = chatId ? bundle.threads.find((t) => t.id === chatId) : undefined
  const chatKey = useRef({ chatId, key: 0 })
  if (chatKey.current.chatId !== chatId) {
    if (!(chatId && chatId === adoptedChat.current)) chatKey.current.key += 1
    chatKey.current.chatId = chatId
  }
  const session = thread?.sessionId ? bundle.sessions.find((s) => s.id === thread.sessionId && !s.endedAt) : undefined

  // --- layout --------------------------------------------------------------------
  const [panelTab, setPanelTab] = useState<PanelTab>('sources')
  const [panelOpen, setPanelOpen] = useState(true)
  const [visited, setVisited] = useState<Set<PanelTab>>(() => {
    const restored = loadSplit().tab
    return new Set<PanelTab>(restored ? ['sources', restored] : ['sources'])
  })
  // Split view: a second tab beside (or below) the first, e.g. Notes next to the Browser.
  const [split, setSplit] = useState<SplitState>(loadSplit)
  const splitTab = split.tab === panelTab ? null : split.tab
  useEffect(() => localStorage.setItem(SPLIT_KEY, JSON.stringify(split)), [split])
  const [swapped, setSwapped] = useState(() => localStorage.getItem(SWAP_KEY) === '1')
  const [panelW, setPanelW] = useState(() => Number(localStorage.getItem(PANEL_W_KEY)) || 560)
  useEffect(() => localStorage.setItem(SWAP_KEY, swapped ? '1' : '0'), [swapped])
  useEffect(() => localStorage.setItem(PANEL_W_KEY, String(Math.round(panelW))), [panelW])

  /** Show a tab in one half of the panel; picking the tab the other half shows swaps them. */
  const setPaneTab = useCallback(
    (pane: 'a' | 'b', tab: PanelTab) => {
      setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)))
      if (pane === 'a') {
        if (tab === splitTab) setSplit((s) => ({ ...s, tab: panelTab }))
        setPanelTab(tab)
      } else {
        if (tab === panelTab && splitTab) setPanelTab(splitTab)
        setSplit((s) => ({ ...s, tab }))
      }
    },
    [panelTab, splitTab]
  )

  /** Bring a tab into view (from a citation, a search…), leaving a split layout as it is when the tab is already showing. */
  const showPanel = useCallback(
    (tab: PanelTab) => {
      setPanelOpen(true)
      if (tab === panelTab || tab === splitTab) return
      setPaneTab('a', tab)
    },
    [panelTab, splitTab, setPaneTab]
  )

  const toggleSplit = () => {
    if (splitTab) return setSplit((s) => ({ ...s, tab: null }))
    const other: PanelTab = panelTab === 'browser' ? 'notes' : 'browser'
    setVisited((v) => new Set(v).add(other))
    setSplit((s) => ({ ...s, tab: other }))
    // Side by side needs room: widen a narrow panel once.
    if (split.dir === 'row') setPanelW((w) => Math.max(w, Math.min(820, Math.round(window.innerWidth * 0.55))))
  }

  const startSplitResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const body = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect()
    const move = (ev: MouseEvent) => {
      const r = split.dir === 'row' ? (ev.clientX - body.left) / body.width : (ev.clientY - body.top) / body.height
      setSplit((s) => ({ ...s, ratio: Math.min(0.8, Math.max(0.2, r)) }))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing', 'resizing-v')
    }
    document.body.classList.add('resizing', ...(split.dir === 'col' ? ['resizing-v'] : []))
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** Where a tab's page sits: the main half, the split half, or hidden. */
  const slot = (tab: PanelTab): 'a' | 'b' | null => (tab === panelTab ? 'a' : tab === splitTab ? 'b' : null)
  const pageClass = (tab: PanelTab, extra = '') => {
    const s = slot(tab)
    return `panel-page ${s ? `active slot-${s}` : 'inactive'} ${extra}`
  }

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelW
    const total = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().width
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      setPanelW(Math.min(total - MIN_CHAT, Math.max(MIN_PANEL, swapped ? startW + dx : startW - dx)))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // --- sources viewer -----------------------------------------------------------
  const [activeSourceId, setActiveSourceId] = useState<string | null>(() => bundle.sources[0]?.id ?? null)
  const [focus, setFocus] = useState<ReaderFocus | null>(null)
  const [textMode, setTextMode] = useState<Set<string>>(new Set())
  const activeMeta = bundle.sources.find((s) => s.id === activeSourceId)
  const { doc, error: docError } = useSourceDoc(classId, activeMeta ? activeSourceId : null, activeMeta ? `${activeMeta.wordCount}:${activeMeta.needsTranscript}` : undefined)
  const pageView = Boolean(activeMeta && activeMeta.kind === 'pdf' && !textMode.has(activeMeta.id))
  const showText = useCallback((id: string) => setTextMode((s) => new Set(s).add(id)), [])
  const onPdfUnavailable = useCallback(() => activeSourceId && showText(activeSourceId), [activeSourceId, showText])

  useEffect(() => {
    if (!activeSourceId || !bundle.sources.some((s) => s.id === activeSourceId)) setActiveSourceId(bundle.sources[0]?.id ?? null)
  }, [bundle.sources, activeSourceId])

  const openSource = useCallback(
    (sourceId: string, section?: string, quote?: string) => {
      showPanel('sources')
      setActiveSourceId(sourceId)
      setFocus({ section, quote, nonce: Date.now() })
    },
    [showPanel]
  )

  // Jumps requested from outside (notebook stickies).
  const lastFocus = useRef(0)
  useEffect(() => {
    if (studyFocus && studyFocus.nonce !== lastFocus.current) {
      lastFocus.current = studyFocus.nonce
      if (bundle.sources.some((s) => s.id === studyFocus.sourceId)) openSource(studyFocus.sourceId, studyFocus.section, studyFocus.quote)
    }
  }, [studyFocus, bundle.sources, openSource])

  // A lesson chat opens its first reading once.
  const openedFor = useRef<string | null>(null)
  useEffect(() => {
    const r = session?.brief?.readings[0]
    if (session && r && openedFor.current !== session.id) {
      openedFor.current = session.id
      openSource(r.sourceId, r.section)
    }
  }, [session, openSource])

  async function addMaterials(paths?: string[]) {
    const picked = paths ?? (await api.system.pickMaterials())
    if (!picked.length) return
    const res = await run(() => api.sources.addFiles(classId, picked))
    if (res) {
      for (const e of res.errors) toast(e, 'error')
      if (res.added[0]) openSource(res.added[0].id)
    }
  }
  const [linkInput, setLinkInput] = useState<string | null>(null)

  // --- chat tools ------------------------------------------------------------------
  const [commandRequest, setCommandRequest] = useState<{ command: ChatCommand; arg?: string; nonce: number } | null>(null)
  const command = useCallback(
    (cmd: ChatCommand, arg?: string) => {
      // Every lesson gets its own chat, like a new thread.
      if (cmd === 'lesson') go({ name: 'class', classId, chatId: null })
      setCommandRequest({ command: cmd, arg, nonce: Date.now() })
    },
    [go, classId]
  )
  /** A highlighted passage to discuss in the main chat ("Chat" on a selection). */
  const [quoteRequest, setQuoteRequest] = useState<{ text: string; source: string; nonce: number } | null>(null)
  const onHandled = useCallback((kind: 'command' | 'quote') => {
    if (kind === 'command') setCommandRequest(null)
    else setQuoteRequest(null)
  }, [])
  const [browserRequest, setBrowserRequest] = useState<{ query: string; nonce: number } | null>(null)

  // --- popovers (side chats) -------------------------------------------------------
  const [selection, setSelection] = useState<(SelectionAnchor & { sourceId: string }) | null>(null)
  const [ask, setAsk] = useState<AskState | null>(null)
  const askRef = useRef(ask)
  askRef.current = ask
  const [note, setNote] = useState<{ annotation: Annotation; pos: { x: number; y: number } } | null>(null)
  const [term, setTerm] = useState<{ anchor: Extract<Anchor, { kind: 'source' }>; pos: { x: number; y: number } } | null>(null)
  const [hidePins, setHidePins] = useState(false)

  // --- diagrams the tutor can point at -------------------------------------------------
  const diagrams = useRef(new Map<string, DiagramController>())
  const lastDiagram = useRef<string | null>(null)
  const registerDiagram = useCallback((id: string, ctl: DiagramController | null) => {
    if (ctl) {
      diagrams.current.set(id, ctl)
      lastDiagram.current = id
    } else diagrams.current.delete(id)
  }, [])

  const handleDirective = useCallback(
    (d: Directive) => {
      if (d.type === 'cite') {
        if (bundle.sources.some((s) => s.id === d.sourceId)) openSource(d.sourceId, d.section, d.quote)
        else toast('That citation points to a source that is no longer in this class.', 'error')
        return
      }
      if (d.type === 'offer') {
        command(d.tool, d.arg)
        return
      }
      const current = askRef.current
      const id = current?.anchor.kind === 'diagram' ? current.anchor.explorableId : lastDiagram.current
      const ctl = id ? diagrams.current.get(id) : undefined
      if (!ctl) return
      if (d.type === 'highlight') ctl.highlight(d.elementId)
      else ctl.set(d.paramId, d.value)
    },
    [bundle.sources, openSource, toast, command]
  )

  // --- ask -------------------------------------------------------------------------
  const threadsById = useMemo(() => new Map(bundle.threads.map((t) => [t.id, t])), [bundle.threads])
  const threadsRef = useRef(threadsById)
  threadsRef.current = threadsById

  /** Keep a side chat the learner moves away from as a sticky beside the page. */
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

  const sourceTitle = useCallback((id: string) => bundle.sources.find((s) => s.id === id)?.title, [bundle.sources])
  const studyApi = useMemo<StudyApi>(
    () => ({
      bundle,
      classId,
      sessionId: session?.id,
      sourceTitle,
      handleDirective,
      ask: askAt,
      openSource,
      command,
      registerDiagram
    }),
    [bundle, classId, session?.id, sourceTitle, handleDirective, askAt, openSource, command, registerDiagram]
  )
  const onOpenThread = useCallback((t: Thread, rect: DOMRect) => askAt(t.anchor, rect, t.id), [askAt])
  const onOpenNote = useCallback((a: Annotation, rect: DOMRect) => setNote({ annotation: a, pos: placeNear(rect) }), [])

  // --- selection actions -------------------------------------------------------------
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

  const [dropping, setDropping] = useState(false)
  const chatTitle = thread?.title ?? 'New chat'

  // --- render --------------------------------------------------------------------------
  const chatPane = (
    <section className="chat-pane">
      <div className="pane-head">
        <div className="crumbs">
          <Icon name="folder" size={14} />
          <span className="ellipsis">{bundle.meta.title}</span>
          <span className="muted">/</span>
          <b className="ellipsis" data-testid="chat-title">
            {chatTitle}
          </b>
        </div>
        <span className="spacer" />
        <Activity classId={classId} />
        <button className="icon-btn" onClick={() => setSwapped((s) => !s)} title="Swap the chat and the panel" aria-label="Swap sides" data-testid="swap">
          <Icon name="swap" size={14} />
        </button>
        <button
          className={`icon-btn ${panelOpen ? 'on' : ''}`}
          onClick={() => setPanelOpen((o) => !o)}
          title={panelOpen ? 'Hide the panel' : 'Show the panel'}
          aria-label="Toggle panel"
          data-testid="toggle-panel"
        >
          <Icon name="sidebar" size={14} />
        </button>
        <ClassMenu
          title={bundle.meta.title}
          onRename={(title) => void run(() => api.classes.update(classId, { title }))}
          onDelete={async () => {
            if (!window.confirm(`Delete "${bundle.meta.title}" and everything in it? This cannot be undone.`)) return
            const ok = await run(async () => {
              await api.classes.remove(classId)
              return true
            })
            if (!ok) return
            const nextClass = classes.find((c) => c.id !== classId)
            go(nextClass ? { name: 'class', classId: nextClass.id } : { name: 'home' })
          }}
        />
      </div>
      <ChatView
        key={chatKey.current.key}
        bundle={bundle}
        thread={thread}
        onThread={(id) => {
          adoptedChat.current = id
          go({ name: 'class', classId, chatId: id })
        }}
        onHandled={onHandled}
        onAddMaterials={() => void addMaterials()}
        commandRequest={commandRequest}
        quoteRequest={quoteRequest}
      />
    </section>
  )

  const panel = (
    <section className="side-panel" data-testid="panel">
      <div className="pane-head">
        <div className="panel-tabs" role="tablist">
          {PANEL_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={panelTab === t.id}
              className={`panel-tab ${panelTab === t.id ? 'active' : splitTab === t.id ? 'in-split' : ''}`}
              onClick={() => {
                setPanelOpen(true)
                setPaneTab('a', t.id)
              }}
              title={splitTab === t.id ? `${t.label} (open in the split; click to swap)` : t.label}
              data-testid={`tab-${t.id}`}
            >
              <Icon name={t.icon} size={13} /> {t.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button
          className={`icon-btn ${splitTab ? 'on' : ''}`}
          onClick={toggleSplit}
          title={splitTab ? 'Close the split' : 'Split: show two tabs at once'}
          aria-label="Split view"
          aria-pressed={Boolean(splitTab)}
          data-testid="split-toggle"
        >
          <Icon name={split.dir === 'row' ? 'splitH' : 'splitV'} size={15} />
        </button>
      </div>

      <div
        className={`panel-body ${splitTab ? `split split-${split.dir}` : ''}`}
        style={splitTab ? ({ ['--split' as string]: String(split.ratio) } as React.CSSProperties) : undefined}
      >
        {splitTab && (
          <>
            <div className="split-head" data-testid="split-head">
              <div className="panel-tabs compact" role="tablist" aria-label="Split tabs">
                {PANEL_TABS.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={splitTab === t.id}
                    className={`panel-tab ${splitTab === t.id ? 'active' : ''}`}
                    onClick={() => setPaneTab('b', t.id)}
                    title={t.label}
                    data-testid={`split-tab-${t.id}`}
                  >
                    <Icon name={t.icon} size={13} />
                    {splitTab === t.id && <span>{t.label}</span>}
                  </button>
                ))}
              </div>
              <span className="spacer" />
              <button
                className="icon-btn"
                onClick={() => setSplit((s) => ({ ...s, dir: s.dir === 'row' ? 'col' : 'row' }))}
                title={split.dir === 'row' ? 'Stack top and bottom' : 'Side by side'}
                aria-label="Change split direction"
                data-testid="split-dir"
              >
                <Icon name={split.dir === 'row' ? 'splitV' : 'splitH'} size={14} />
              </button>
              <button className="icon-btn" onClick={() => setSplit((s) => ({ ...s, tab: null }))} title="Close the split" aria-label="Close the split" data-testid="split-close">
                <Icon name="x" size={13} />
              </button>
            </div>
            <div className="split-divider" onMouseDown={startSplitResize} role="separator" aria-orientation={split.dir === 'row' ? 'vertical' : 'horizontal'} aria-label="Resize the split" />
          </>
        )}
        {/* Sources and Browser stay mounted, so switching tabs keeps your place. */}
        <div className={pageClass('sources')} data-testid="page-sources">
          <div className="source-bar">
            <div className="source-tabs">
              {bundle.sources.map((s) => (
                <button
                  key={s.id}
                  className={`source-chip ${s.id === activeSourceId ? 'on' : ''}`}
                  onClick={() => setActiveSourceId(s.id)}
                  title={s.title}
                  data-testid="source-tab"
                >
                  <Icon name={KIND_ICON[s.kind]} size={12} />
                  <span className="ellipsis">{s.title}</span>
                </button>
              ))}
            </div>
            {activeMeta?.kind === 'pdf' && linkInput === null && (
              <div className="seg" role="group" aria-label="PDF view">
                <button className={pageView ? 'on' : ''} onClick={() => setTextMode((s) => new Set([...s].filter((x) => x !== activeMeta.id)))} data-testid="view-page">
                  Page
                </button>
                <button className={!pageView ? 'on' : ''} onClick={() => showText(activeMeta.id)} data-testid="view-text">
                  Text
                </button>
              </div>
            )}
            {linkInput === null && (
              <button className="icon-btn" onClick={() => setHidePins((h) => !h)} title={hidePins ? 'Show stickies' : 'Hide stickies'} aria-label="Toggle stickies" data-testid="toggle-pins">
                <Icon name={hidePins ? 'eyeOff' : 'eye'} size={14} />
              </button>
            )}
            {linkInput !== null ? (
              <form
                className="source-link"
                onSubmit={async (e) => {
                  e.preventDefault()
                  const url = linkInput.trim()
                  if (!url) return
                  const s = await run(() => api.sources.addUrl(classId, url))
                  if (s) {
                    setLinkInput(null)
                    openSource(s.id)
                  }
                }}
              >
                <input
                  className="input sm"
                  autoFocus
                  placeholder="https://… (page, PDF, YouTube)"
                  value={linkInput}
                  onChange={(e) => setLinkInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setLinkInput(null)}
                  onBlur={() => !linkInput.trim() && setLinkInput(null)}
                  data-testid="source-link-input"
                />
              </form>
            ) : (
              <>
                <button className="icon-btn" onClick={() => setLinkInput('')} title="Add a link" aria-label="Add a link" data-testid="add-link">
                  <Icon name="link" size={13} />
                </button>
                <button className="icon-btn" onClick={() => void addMaterials()} title="Add files or a folder" aria-label="Add files" data-testid="add-files">
                  <Icon name="plus" size={14} />
                </button>
                {activeMeta && (
                  <button
                    className="icon-btn"
                    title="Remove this source from the class"
                    aria-label={`Remove ${activeMeta.title}`}
                    onClick={() => {
                      if (window.confirm(`Remove "${activeMeta.title}" from this class?`)) void run(() => api.sources.remove(classId, activeMeta.id))
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </>
            )}
          </div>
          <div
            className={`reader-wrap ${dropping ? 'dropping' : ''}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              setDropping(true)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false)
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.files.length) return
              e.preventDefault()
              setDropping(false)
              void addMaterials(Array.from(e.dataTransfer.files).map((f) => window.mintHost.pathForFile(f)).filter(Boolean))
            }}
          >
            {!activeMeta ? (
              <EmptySources bundle={bundle} onPick={() => void addMaterials()} />
            ) : docError ? (
              <div className="empty">{docError}</div>
            ) : !doc ? (
              <div className="empty">
                <span className="spinner" />
              </div>
            ) : pageView ? (
              <PdfView
                key={doc.id}
                doc={doc}
                annotations={bundle.annotations}
                threads={bundle.threads}
                focus={focus}
                hidePins={hidePins}
                openThreadId={ask?.threadId ?? null}
                onSelection={onSelection}
                onOpenThread={onOpenThread}
                onOpenNote={onOpenNote}
                onUnavailable={onPdfUnavailable}
              />
            ) : (
              <Reader
                key={doc.id}
                doc={doc}
                annotations={bundle.annotations}
                threads={bundle.threads}
                focus={focus}
                hidePins={hidePins}
                openThreadId={ask?.threadId ?? null}
                onSelection={onSelection}
                onOpenThread={onOpenThread}
                onOpenNote={onOpenNote}
              />
            )}
            {dropping && <div className="drop-overlay">Drop to add to {bundle.meta.title}</div>}
          </div>
        </div>

        {visited.has('browser') && (
          <div className={pageClass('browser')} data-testid="page-browser">
            <ErrorBoundary label="the browser">
              <BrowserPanel classId={classId} request={browserRequest} />
            </ErrorBoundary>
          </div>
        )}
        {slot('lessons') && (
          <div className={pageClass('lessons', 'scroll')} data-testid="page-lessons">
            <ErrorBoundary label="lessons">
            <LessonsPanel
              bundle={bundle}
              onStart={(topicId) => command('lesson', topicId)}
              onResume={(sessionId) => {
                const t = chats.find((x) => x.sessionId === sessionId)
                if (t) go({ name: 'class', classId, chatId: t.id })
                else command('lesson', bundle.sessions.find((s) => s.id === sessionId)?.topicId)
              }}
              openSource={(sid, sec) => openSource(sid, sec)}
            />
            </ErrorBoundary>
          </div>
        )}
        {/* Notes stay mounted too, so a half-written note survives a tab switch. */}
        <div className={pageClass('notes')} data-testid="page-notes">
          <ErrorBoundary label="notes">
            <NotesPanel bundle={bundle} />
          </ErrorBoundary>
        </div>
      </div>
    </section>
  )

  return (
    <StudyCtx.Provider value={studyApi}>
      <div className={`workspace ${swapped ? 'swapped' : ''} ${panelOpen ? '' : 'no-panel'}`} style={{ ['--panel-w' as string]: `${panelW}px` }}>
        {swapped && panelOpen ? panel : chatPane}
        {panelOpen && <div className="splitter" onMouseDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize" />}
        {panelOpen && (swapped ? chatPane : panel)}
      </div>

      {selection && !ask && (
        <SelectionToolbar
          rect={selection.rect}
          onChat={() => {
            const source = [sourceTitle(selection.sourceId) ?? 'Source', selection.sectionLabel].filter(Boolean).join(' · ')
            setQuoteRequest({ text: selection.quote, source, nonce: Date.now() })
            clearSelection()
          }}
          onAsk={() => askAt(sourceAnchor(selection), selection.rect)}
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
          onDiagram={() => {
            const anchor = sourceAnchor(selection)
            clearSelection()
            command('diagram', `Help me understand: "${anchor.quote.slice(0, 300)}"`)
          }}
          onTerm={() => {
            const anchor = sourceAnchor(selection)
            setTerm({ anchor, pos: placeNear(selection.rect) })
            clearSelection()
          }}
          onSearch={() => {
            const q = selection.quote.slice(0, 200)
            clearSelection()
            showPanel('browser')
            setBrowserRequest({ query: q, nonce: Date.now() })
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
            // Continue the side chat as a main chat.
            if (ask.threadId) {
              const t = threadsById.get(ask.threadId)
              if (t?.anchor.kind === 'general') go({ name: 'class', classId, chatId: t.id })
              else pinIfNeeded(ask.threadId)
            }
            setAsk(null)
          }}
          onThread={(id) => {
            const key = ask.key
            // Only the popover that asked may adopt the thread; if it is gone, keep the thread as a sticky.
            if (askRef.current?.key === key) setAsk((a) => (a && a.key === key ? { ...a, threadId: id } : a))
            else void api.threads.setPinned(classId, id, true).catch(() => undefined)
          }}
        />
      )}
      {note && <NotePopover annotation={note.annotation} pos={note.pos} onMove={(pos) => setNote((n) => (n ? { ...n, pos } : n))} onClose={() => setNote(null)} />}
      {term && <TermPopover anchor={term.anchor} pos={term.pos} onMove={(pos) => setTerm((t) => (t ? { ...t, pos } : t))} onClose={() => setTerm(null)} />}
    </StudyCtx.Provider>
  )
}

function EmptySources({ bundle, onPick }: { bundle: ClassBundle; onPick: () => void }): JSX.Element {
  const { jobs } = useApp()
  const importing = jobs.find((j) => j.classId === bundle.meta.id && /^(Reading|Importing)/.test(j.label))
  return (
    <div className="empty">
      {importing ? (
        <div className="status-line">
          <span className="spinner tiny" /> {importing.label}…
        </div>
      ) : (
        <>
          <p>No sources yet. Drop files or a folder here, add a link, or let the tutor find trusted sources.</p>
          <button className="btn" onClick={onPick} data-testid="reader-add">
            <Icon name="plus" size={13} /> Add materials
          </button>
        </>
      )}
    </div>
  )
}

function ClassMenu({ title, onRename, onDelete }: { title: string; onRename: (title: string) => void; onDelete: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(title)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    setName(title)
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, title])
  return (
    <div className="menu-anchor" ref={ref}>
      <button className="icon-btn" aria-label="Class options" title="Class options" onClick={() => setOpen((o) => !o)} data-testid="class-menu">
        <Icon name="more" size={15} />
      </button>
      {open && (
        <div className="menu">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim() && name.trim() !== title) onRename(name.trim())
              setOpen(false)
            }}
          >
            <label className="dlabel" htmlFor="rename-class">
              Class name
            </label>
            <input id="rename-class" className="input sm" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </form>
          <button
            className="menu-item danger"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
            data-testid="delete-class"
          >
            <Icon name="trash" size={13} /> Delete class
          </button>
        </div>
      )}
    </div>
  )
}
