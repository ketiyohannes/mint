import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Anchor, Annotation, ChatCommand, ClassBundle, Thread } from '@shared/types'
import type { Directive } from '@shared/directives'
import { findTopic } from '@shared/curriculum'
import { useApp } from '../state/app'
import { useSourceDoc } from '../state/useClass'
import { api } from '../lib/api'
import { clearClassDrafts } from '../lib/drafts'
import { matchesShortcut, shortcutLabel } from '../lib/shortcuts'
import type { SelectionAnchor } from '../lib/anchors'
import { Icon, type IconName } from '../components/Icon'
import { Activity } from '../components/Activity'
import { FocusTimer } from '../components/FocusTimer'
import { KIND_ICON } from '../components/Sidebar'
import { Reader, type ReaderFocus } from './study/Reader'
import { PdfView } from './study/PdfView'
import { AskPopover, NotePopover, SelectionToolbar, TermPopover, placeExpanded, placeNear, type AskState } from './study/Popovers'
import { StudyCtx, type DiagramController, type StudyApi } from './study/context'
import { ChatView } from './chat/ChatView'
import { LessonsPanel } from './LessonsPanel'
import { StudyTab } from './study/StudyTab'
import { LessonDock } from './study/LessonDock'
import { useDarkTheme } from '../lib/useDarkTheme'
import { BrowserPanel, forgetBrowserPage } from './BrowserPanel'
import { forgetPositions } from './study/position'
import { NotesPanel } from './notes/NotesPanel'
import { ErrorBoundary } from '../components/ErrorBoundary'

type PanelTab = 'sources' | 'lessons' | 'study' | 'browser' | 'notes'

interface SplitState {
  /** The second tab, or null when the panel shows one tab. */
  tab: PanelTab | null
  /** row: side by side; col: stacked. */
  dir: 'row' | 'col'
  /** Share of the panel given to the first tab (0.2 to 0.8). */
  ratio: number
}

const SPLIT_KEY = 'mint.split'
const PANEL_TAB_IDS: PanelTab[] = ['sources', 'lessons', 'study', 'browser', 'notes']

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
  { id: 'study', label: 'Study', icon: 'study' },
  { id: 'browser', label: 'Browser', icon: 'globe' },
  { id: 'notes', label: 'Notes', icon: 'notebook' }
]

/** Whether the panel is showing, and its tab. */
const PANEL_KEY = 'mint.panel'

function loadPanel(): { open: boolean; tab: PanelTab } {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_KEY) ?? 'null') as { open?: unknown; tab?: PanelTab } | null
    return { open: raw?.open !== false, tab: raw?.tab && PANEL_TAB_IDS.includes(raw.tab) ? raw.tab : 'sources' }
  } catch {
    return { open: true, tab: 'sources' }
  }
}

const PANEL_W_KEY = 'mint.panelWidth'
/** 'dark' or 'light' PDF pages; unset follows the app theme. */
const PDF_PAGES_KEY = 'mint.pdfPages'
const SWAP_KEY = 'mint.swapped'
const DOCK_FOLDED_KEY = 'mint.lessonDock.folded'
const DEFAULT_PANEL = 560
// The narrowest each side gets. styles.css clamps the panel with the same two numbers (--panel-min, --chat-min).
const MIN_PANEL = 340
const MIN_CHAT = 420

/**
 * A class, like a project in a coding agent: the chat with the tutor, and a
 * panel with your sources, lessons, a browser for your own research, and
 * notes. The chat and the panel can swap sides. The class's open lesson docks
 * over whichever chat is showing (or sits in the panel's Study tab).
 */
export function Workspace({ bundle, chatId }: { bundle: ClassBundle; chatId: string | null | undefined }): JSX.Element {
  const { toast, run, go, classes, settings, setSettings } = useApp()
  /** The open lesson docks over the chat unless Settings puts it in the Study tab (otherwise there is no Study tab). */
  const docked = (settings?.lessonView ?? 'dock') === 'dock'
  const panelTabs = useMemo(() => (docked ? PANEL_TABS.filter((t) => t.id !== 'study') : PANEL_TABS), [docked])
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
    // The adoption ends once the route leaves that chat: coming back to it later gets a fresh view.
    if (chatId !== adoptedChat.current) adoptedChat.current = null
    chatKey.current.chatId = chatId
  }
  /**
   * The class's open lesson, the same in every chat. A finished one stays open
   * (showing its summary) until it is closed.
   */
  const openLesson = bundle.meta.openLessonId ? bundle.sessions.find((s) => s.id === bundle.meta.openLessonId) : undefined
  const session = openLesson && !openLesson.endedAt ? openLesson : undefined

  // --- layout --------------------------------------------------------------------
  const [panelTab, setPanelTab] = useState<PanelTab>(() => loadPanel().tab)
  const [panelOpen, setPanelOpen] = useState(() => loadPanel().open)
  useEffect(() => localStorage.setItem(PANEL_KEY, JSON.stringify({ open: panelOpen, tab: panelTab })), [panelOpen, panelTab])
  const [visited, setVisited] = useState<Set<PanelTab>>(() => {
    const restored = loadSplit().tab
    return new Set<PanelTab>(['sources', loadPanel().tab, ...(restored ? [restored] : [])])
  })
  // Split view: a second tab beside (or below) the first, e.g. Notes next to the Browser.
  const [split, setSplit] = useState<SplitState>(loadSplit)
  const splitTab = split.tab === panelTab ? null : split.tab
  useEffect(() => localStorage.setItem(SPLIT_KEY, JSON.stringify(split)), [split])
  const [swapped, setSwapped] = useState(() => localStorage.getItem(SWAP_KEY) === '1')
  const [panelW, setPanelW] = useState(() => Number(localStorage.getItem(PANEL_W_KEY)) || DEFAULT_PANEL)
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

  // Side by side needs room: widen a narrow panel when a split opens.
  const widenForSplit = useCallback(() => {
    if (split.dir === 'row') setPanelW((w) => Math.max(w, Math.min(820, Math.round(window.innerWidth * 0.55))))
  }, [split.dir])

  /**
   * Bring a tab into view (from a citation, a search…), leaving a split layout
   * as it is when the tab is already showing. The Study tab stays in view: a
   * reading opened during a lesson goes beside it.
   */
  const showPanel = useCallback(
    (tab: PanelTab) => {
      setPanelOpen(true)
      if (tab === panelTab || tab === splitTab) return
      if (tab !== 'study' && panelTab === 'study') {
        if (!splitTab) widenForSplit()
        return setPaneTab('b', tab)
      }
      setPaneTab('a', tab)
    },
    [panelTab, splitTab, setPaneTab, widenForSplit]
  )

  // Lessons dock over the chat: the Study tab goes away, wherever it was showing.
  // (Not before Settings load: a Study tab remembered from the last run must survive the start.)
  const settingsLoaded = Boolean(settings)
  useEffect(() => {
    if (!docked || !settingsLoaded) return
    if (panelTab === 'study') {
      setPanelTab(splitTab ?? 'lessons')
      if (splitTab) setSplit((s) => ({ ...s, tab: null }))
    } else if (split.tab === 'study') setSplit((s) => ({ ...s, tab: null }))
  }, [docked, settingsLoaded, panelTab, splitTab, split.tab])

  const [dockFolded, setDockFolded] = useState(() => localStorage.getItem(DOCK_FOLDED_KEY) === '1')
  useEffect(() => localStorage.setItem(DOCK_FOLDED_KEY, dockFolded ? '1' : '0'), [dockFolded])

  /** Bring the open lesson into view: unfold the dock, or show the Study tab. */
  const revealLesson = useCallback(() => {
    if (docked) return setDockFolded(false)
    setPanelOpen(true)
    setPaneTab('a', 'study')
  }, [docked, setPaneTab])

  const toggleSplit = () => {
    if (splitTab) return setSplit((s) => ({ ...s, tab: null }))
    const other: PanelTab = panelTab === 'browser' ? 'notes' : 'browser'
    setVisited((v) => new Set(v).add(other))
    setSplit((s) => ({ ...s, tab: other }))
    widenForSplit()
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
    const workspace = (e.currentTarget as HTMLElement).parentElement!
    // Start from the width on screen: the remembered one may be wider than this window allows.
    const startW = workspace.querySelector(':scope > .side-panel')?.getBoundingClientRect().width ?? panelW
    const total = workspace.getBoundingClientRect().width
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      setPanelW(Math.max(MIN_PANEL, Math.min(total - MIN_CHAT - 1, swapped ? startW + dx : startW - dx)))
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
  /** A jump to a section or quote, for the source it was asked on only. */
  const [focus, setFocus] = useState<(ReaderFocus & { sourceId: string }) | null>(null)
  const [textMode, setTextMode] = useState<Set<string>>(new Set())
  const activeMeta = bundle.sources.find((s) => s.id === activeSourceId)
  const { doc, error: docError } = useSourceDoc(classId, activeMeta ? activeSourceId : null, activeMeta ? `${activeMeta.wordCount}:${activeMeta.needsTranscript}` : undefined)
  const pageView = Boolean(activeMeta && activeMeta.kind === 'pdf' && !textMode.has(activeMeta.id))
  const showText = useCallback((id: string) => setTextMode((s) => new Set(s).add(id)), [])
  // PDF pages follow the app theme until you pick dark or light pages yourself.
  const appDark = useDarkTheme()
  const [pdfPages, setPdfPages] = useState<'dark' | 'light' | null>(() => {
    const v = localStorage.getItem(PDF_PAGES_KEY)
    return v === 'dark' || v === 'light' ? v : null
  })
  const pdfDark = pdfPages ? pdfPages === 'dark' : appDark
  const togglePdfDark = () => {
    const next = pdfDark ? 'light' : 'dark'
    // Picking what the theme would show anyway goes back to following the theme.
    const pick = (next === 'dark') === appDark ? null : next
    setPdfPages(pick)
    if (pick) localStorage.setItem(PDF_PAGES_KEY, pick)
    else localStorage.removeItem(PDF_PAGES_KEY)
  }
  const onPdfUnavailable = useCallback(() => activeSourceId && showText(activeSourceId), [activeSourceId, showText])

  useEffect(() => {
    if (!activeSourceId || !bundle.sources.some((s) => s.id === activeSourceId)) setActiveSourceId(bundle.sources[0]?.id ?? null)
  }, [bundle.sources, activeSourceId])

  const openSource = useCallback(
    (sourceId: string, section?: string, quote?: string) => {
      showPanel('sources')
      setActiveSourceId(sourceId)
      setFocus({ sourceId, section, quote, nonce: Date.now() })
    },
    [showPanel]
  )

  // A lesson that becomes the open one (started, or resumed from any chat)
  // comes into view, with its first reading open in the panel the first time.
  // A lesson already open when the class opens stays as it was left.
  const shownLesson = useRef(bundle.meta.openLessonId)
  const readingOpenedFor = useRef<string | null>(null)
  useEffect(() => {
    if (session?.id === shownLesson.current) return
    shownLesson.current = session?.id
    if (!session) return
    const r = session.brief?.readings[0]
    const openReading = Boolean(r) && readingOpenedFor.current !== session.id
    if (r) readingOpenedFor.current = session.id
    if (docked) {
      setDockFolded(false)
      if (r && openReading) openSource(r.sourceId, r.section)
      return
    }
    // Set the layout directly: showPanel would read the panel state from before this render.
    setPanelOpen(true)
    setPaneTab('a', 'study')
    if (r && openReading) {
      setVisited((v) => new Set(v).add('sources'))
      if (!splitTab) widenForSplit()
      setSplit((sp) => ({ ...sp, tab: 'sources' }))
      setActiveSourceId(r.sourceId)
      setFocus({ sourceId: r.sourceId, section: r.section, nonce: Date.now() })
    }
  }, [session, docked, openSource, splitTab, setPaneTab, widenForSplit])

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
  const [addingLink, setAddingLink] = useState(false)

  // --- chat tools ------------------------------------------------------------------
  const [commandRequest, setCommandRequest] = useState<{ command: ChatCommand; arg?: string; nonce: number } | null>(null)
  // Tools run in the chat that is showing (a new one from the class home); a lesson started there opens over every chat.
  const command = useCallback((cmd: ChatCommand, arg?: string) => setCommandRequest({ command: cmd, arg, nonce: Date.now() }), [])
  /**
   * Resume a lesson where you are: it becomes the class's open lesson, over
   * the chat that is showing. A finished or missing one starts afresh.
   */
  const openLessonById = useCallback(
    (sessionId: string) => {
      const s = bundle.sessions.find((x) => x.id === sessionId)
      // A re-plan may have dropped that lesson's topic: then the next lesson starts instead.
      if (!s || (s.endedAt && s.id !== bundle.meta.openLessonId)) return command('lesson', s && findTopic(bundle.curriculum, s.topicId) ? s.topicId : undefined)
      if (s.id === bundle.meta.openLessonId) return revealLesson()
      void run(() => api.sessions.open(classId, s.id))
    },
    [bundle.sessions, bundle.curriculum, bundle.meta.openLessonId, command, revealLesson, run, classId]
  )
  const closeLesson = useCallback(() => void run(() => api.sessions.open(classId, null)), [run, classId])
  /** The Settings choice, from the dock or the Study tab. */
  const setLessonView = useCallback(
    async (lessonView: 'dock' | 'tab') => {
      const s = await run(() => api.settings.update({ lessonView }))
      if (!s) return
      setSettings(s)
      if (lessonView === 'dock') return setDockFolded(false)
      setPanelOpen(true)
      setPaneTab('a', 'study')
    },
    [run, setSettings, setPaneTab]
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
  const [term, setTerm] = useState<{ key: number; anchor: Extract<Anchor, { kind: 'source' }>; pos: { x: number; y: number } } | null>(null)
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
      openLesson: openLessonById,
      openLessons: () => showPanel('lessons'),
      registerDiagram
    }),
    [bundle, classId, session?.id, sourceTitle, handleDirective, askAt, openSource, command, openLessonById, showPanel, registerDiagram]
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

  // Shortcuts of the open class: the panel, and stepping through the chats in the sidebar's order.
  const keys = useRef({ chats, chatId })
  keys.current = { chats, chatId }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (matchesShortcut(e, 'togglePanel')) {
        e.preventDefault()
        return setPanelOpen((o) => !o)
      }
      const step = matchesShortcut(e, 'nextChat') ? 1 : matchesShortcut(e, 'previousChat') ? -1 : 0
      const { chats, chatId } = keys.current
      if (!step || !chats.length) return
      e.preventDefault()
      const at = chats.findIndex((t) => t.id === chatId)
      const next = at < 0 ? (step > 0 ? 0 : chats.length - 1) : (at + step + chats.length) % chats.length
      go({ name: 'class', classId, chatId: chats[next].id })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [classId, go])

  // --- render --------------------------------------------------------------------------
  const chatPane = (
    <section key="chat" className={`chat-pane ${docked && openLesson ? 'has-dock' : ''}`} data-testid="chat-pane">
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
        <FocusTimer />
        <button className="icon-btn" onClick={() => setSwapped((s) => !s)} title="Swap the chat and the panel" aria-label="Swap sides" data-testid="swap">
          <Icon name="swap" size={14} />
        </button>
        <button
          className={`icon-btn ${panelOpen ? 'on' : ''}`}
          onClick={() => setPanelOpen((o) => !o)}
          title={`${panelOpen ? 'Hide the panel' : 'Show the panel'} (${shortcutLabel('togglePanel')})`}
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
            clearClassDrafts(classId)
            forgetPositions(classId)
            forgetBrowserPage(classId)
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
      {docked && openLesson && (
        <LessonDock
          key={openLesson.id}
          session={openLesson}
          folded={dockFolded}
          onFold={setDockFolded}
          onClose={closeLesson}
          onMoveToTab={() => void setLessonView('tab')}
          onOpenReading={(sid, sec) => openSource(sid, sec)}
          onDone={() => showPanel('lessons')}
        />
      )}
    </section>
  )

  const panel = (
    <section key="panel" className="side-panel" data-testid="panel">
      <div className="pane-head">
        <div className="panel-tabs" role="tablist">
          {panelTabs.map((t) => (
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

      <div className={`panel-body ${splitTab ? `split split-${split.dir}` : ''}`} style={splitTab ? ({ ['--split' as string]: String(split.ratio) } as React.CSSProperties) : undefined}>
        {splitTab && (
          <>
            <div className="split-head" data-testid="split-head">
              <div className="panel-tabs compact" role="tablist" aria-label="Split tabs">
                {panelTabs.map((t) => (
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
                  onClick={() => {
                    setActiveSourceId(s.id)
                    // Picked by hand: an earlier jump to a citation is done with.
                    setFocus(null)
                  }}
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
            {pageView && linkInput === null && (
              <button
                className={`icon-btn ${pdfDark ? 'on' : ''}`}
                onClick={togglePdfDark}
                title={pdfDark ? 'Light pages' : 'Dark pages'}
                aria-label="Dark pages"
                aria-pressed={pdfDark}
                data-testid="pdf-dark"
              >
                <Icon name={pdfDark ? 'sun' : 'moon'} size={14} />
              </button>
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
                  // One import per link: a second Enter while it loads must not add it twice.
                  if (!url || addingLink) return
                  setAddingLink(true)
                  const s = await run(() => api.sources.addUrl(classId, url))
                  setAddingLink(false)
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
                  readOnly={addingLink}
                  onChange={(e) => setLinkInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && !addingLink && setLinkInput(null)}
                  onBlur={() => !linkInput.trim() && setLinkInput(null)}
                  data-testid="source-link-input"
                />
                {addingLink && <span className="spinner tiny" data-testid="source-link-busy" />}
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
                    data-testid="remove-source"
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
              void addMaterials(
                Array.from(e.dataTransfer.files)
                  .map((f) => window.mintHost.pathForFile(f))
                  .filter(Boolean)
              )
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
                focus={focus && focus.sourceId === doc.id ? focus : null}
                hidePins={hidePins}
                openThreadId={ask?.threadId ?? null}
                onSelection={onSelection}
                onOpenThread={onOpenThread}
                onOpenNote={onOpenNote}
                onUnavailable={onPdfUnavailable}
                dark={pdfDark}
              />
            ) : (
              <Reader
                key={doc.id}
                doc={doc}
                annotations={bundle.annotations}
                threads={bundle.threads}
                focus={focus && focus.sourceId === doc.id ? focus : null}
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
        {/* The study box stays mounted, so a half-written answer survives a tab switch. */}
        {!docked && (
          <div className={pageClass('study', 'scroll')} data-testid="page-study">
            <ErrorBoundary label="the study box">
              <StudyTab
                bundle={bundle}
                session={openLesson}
                onOpenReading={(sid, sec) => openSource(sid, sec)}
                onResume={openLessonById}
                onStartNext={() => command('lesson')}
                onDone={() => showPanel('lessons')}
                onClose={() => {
                  closeLesson()
                  showPanel('lessons')
                }}
                onDock={() => void setLessonView('dock')}
              />
            </ErrorBoundary>
          </div>
        )}
        {slot('lessons') && (
          <div className={pageClass('lessons', 'scroll')} data-testid="page-lessons">
            <ErrorBoundary label="lessons">
              <LessonsPanel bundle={bundle} onStart={(topicId) => command('lesson', topicId)} onResume={openLessonById} openSource={(sid, sec) => openSource(sid, sec)} />
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
      {/*
        The chat always comes first in the document and the panel last; `swapped` trades their
        places in CSS. Moving them in the document would remount both (the browser would reload,
        the reader would lose its place, a streaming reply would be cut off).
      */}
      <div
        className={`workspace ${swapped ? 'swapped' : ''} ${panelOpen ? '' : 'no-panel'}`}
        style={{ ['--panel-w' as string]: `${panelW}px`, ['--panel-min' as string]: `${MIN_PANEL}px`, ['--chat-min' as string]: `${MIN_CHAT}px` }}
      >
        {chatPane}
        {panelOpen && (
          <div
            key="splitter"
            className="splitter"
            onMouseDown={startResize}
            onDoubleClick={() => setPanelW(DEFAULT_PANEL)}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize"
            title="Drag to resize, double-click to reset"
            data-testid="splitter"
          />
        )}
        {panelOpen && panel}
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
            const known = new Set(bundle.annotations.map((a) => a.id))
            clearSelection()
            // Open the new note for writing once it exists (and only the new one: an older note on the same words stays shut).
            const fresh = await run(async () => {
              await api.annotations.create(classId, anchor, 'note', '')
              return api.classes.get(classId)
            })
            const created = fresh && [...fresh.annotations].reverse().find((a) => a.kind === 'note' && !known.has(a.id) && a.anchor.quote === anchor.quote)
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
            setTerm({ key: Date.now(), anchor, pos: placeNear(selection.rect) })
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
          onExpand={(expanded) => setAsk((a) => (a ? { ...a, expanded, pos: expanded ? placeExpanded(a.pos) : a.pos } : a))}
          onThread={(id) => {
            const key = ask.key
            // Only the popover that asked may adopt the thread; if it is gone, keep the thread as a sticky.
            if (askRef.current?.key === key) setAsk((a) => (a && a.key === key ? { ...a, threadId: id } : a))
            else void api.threads.setPinned(classId, id, true).catch(() => undefined)
          }}
        />
      )}
      {note && <NotePopover key={note.annotation.id} annotation={note.annotation} pos={note.pos} onMove={(pos) => setNote((n) => (n ? { ...n, pos } : n))} onClose={() => setNote(null)} />}
      {term && <TermPopover key={term.key} anchor={term.anchor} pos={term.pos} onMove={(pos) => setTerm((t) => (t ? { ...t, pos } : t))} onClose={() => setTerm(null)} />}
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      // Back to the button that opened the menu.
      ref.current?.querySelector('button')?.focus()
    }
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
