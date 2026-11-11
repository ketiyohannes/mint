import { useEffect, useRef, useState, type JSX } from 'react'
import { LAST_CLASS_KEY, useApp, type Route } from './state/app'
import { useClassBundle } from './state/useClass'
import { Sidebar } from './components/Sidebar'
import { isTypingTarget, matchesShortcut, shortcutLabel } from './lib/shortcuts'
import { Toasts } from './components/Toasts'
import { SettingsView } from './views/SettingsView'
import { Workspace } from './views/Workspace'
import { Icon } from './components/Icon'
import { api } from './lib/api'
import { useUpdates } from './lib/useUpdates'
import { useDarkTheme } from './lib/useDarkTheme'
import { holdForClass, useWindowMessages } from './lib/windows'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FocusHost } from './components/FocusTimer'

const SIDEBAR_KEY = 'mint.sidebar'

export function App(): JSX.Element {
  const { route, go, classes, classesLoaded, run, refreshClasses } = useApp()
  const classId = route.name === 'class' ? route.classId : null
  const loaded = useClassBundle(classId)
  // Never hand the previous class's bundle to the next class while it loads.
  const bundle = loaded.bundle && loaded.bundle.meta.id === classId ? loaded.bundle : null
  const error = loaded.error
  const [creating, setCreating] = useState(false)

  // The sidebar folds away for more room, like a code editor's (⌘B / Ctrl+B).
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== 'hidden')
  useEffect(() => localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? 'shown' : 'hidden'), [sidebarOpen])
  // Shortcuts that work anywhere in the window (lib/shortcuts.ts lists them all).
  const nav = useRef({ route, classes })
  nav.current = { route, classes }
  /** Where Esc in Settings goes back to. */
  const beforeSettings = useRef<Route | null>(null)
  if (route.name !== 'settings') beforeSettings.current = route
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An editor that used the key (a code exercise's ⌘/, say) keeps it.
      if (e.defaultPrevented) return
      const { route, classes } = nav.current
      const lastClass = () => classes.find((c) => c.id === localStorage.getItem(LAST_CLASS_KEY))?.id ?? classes[0]?.id
      if (matchesShortcut(e, 'toggleSidebar')) {
        // Rich-text editors (notes) keep the key for bold.
        if (e.target instanceof HTMLElement && e.target.isContentEditable) return
        e.preventDefault()
        setSidebarOpen((o) => !o)
      } else if (matchesShortcut(e, 'newChat')) {
        const classId = route.name === 'class' ? route.classId : lastClass()
        if (!classId) return
        e.preventDefault()
        go({ name: 'class', classId, chatId: null })
      } else if (matchesShortcut(e, 'settings') || matchesShortcut(e, 'shortcuts')) {
        e.preventDefault()
        go(matchesShortcut(e, 'shortcuts') ? { name: 'settings', section: 'shortcuts' } : { name: 'settings' })
      } else if (e.key === 'Escape' && !e.isComposing && route.name === 'settings' && !isTypingTarget(e.target)) {
        const classId = lastClass()
        e.preventDefault()
        go(beforeSettings.current ?? (classId ? { name: 'class', classId } : { name: 'home' }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])
  // The lesson's or the panel's window asked something of the chat while this window was elsewhere
  // (Settings, another class): go to that class, where the workspace takes it from there.
  useWindowMessages((m) => {
    if (m.type !== 'command' && m.type !== 'quote' && m.type !== 'reveal-lesson') return
    const { route, classes } = nav.current
    if ((route.name === 'class' && route.classId === m.classId) || !classes.some((c) => c.id === m.classId)) return
    holdForClass(m)
    go({ name: 'class', classId: m.classId })
  })
  // The window's own controls (drawn over the app on Windows) follow the theme.
  const dark = useDarkTheme()
  useEffect(() => void api.system.windowTheme(dark).catch(() => undefined), [dark])

  // An update waiting in the hidden sidebar still gets noticed.
  const updateState = useUpdates().status?.state.status
  const updateWaiting = updateState === 'available' || updateState === 'ready'

  // Like reopening the last project: start in the most recent class.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !classes.length) return
    restored.current = true
    const last = localStorage.getItem(LAST_CLASS_KEY)
    if (route.name === 'home') go({ name: 'class', classId: classes.find((c) => c.id === last)?.id ?? classes[0].id })
  }, [classes, route.name, go])

  // A class deleted elsewhere: fall back to the next one.
  useEffect(() => {
    if (classId && error && !classes.some((c) => c.id === classId)) go(classes[0] ? { name: 'class', classId: classes[0].id } : { name: 'home' })
  }, [classId, error, classes, go])

  async function start(paths: string[]) {
    setCreating(true)
    const meta = await run(() => api.classes.start({ paths }))
    setCreating(false)
    if (meta) {
      await refreshClasses()
      go({ name: 'class', classId: meta.id, chatId: null })
    }
  }

  return (
    <div className={`app ${sidebarOpen ? '' : 'sidebar-hidden'}`}>
      {sidebarOpen && <Sidebar bundle={bundle} onCollapse={() => setSidebarOpen(false)} />}
      <main className="main">
        {route.name === 'settings' ? (
          <SettingsView />
        ) : classId ? (
          bundle ? (
            <ErrorBoundary key={classId} label="this class">
              <Workspace bundle={bundle} chatId={route.name === 'class' ? route.chatId : undefined} />
            </ErrorBoundary>
          ) : error ? (
            <div className="empty">{error}</div>
          ) : (
            <div className="empty">
              <span className="spinner" />
            </div>
          )
        ) : !classesLoaded || classes.length ? (
          // Classes are still loading, or the last one is about to open: no welcome yet.
          <div className="empty" />
        ) : (
          <div className="welcome">
            <div className="welcome-inner">
              <div className="welcome-mark">
                <span className="brand-mark" aria-hidden="true" />
                mint
              </div>
              <p className="muted">Open a folder of books, papers, notes or slides. Then tell the tutor what you want to learn. The more you use it, the less you will need it.</p>
              <div className="row" style={{ justifyContent: 'center' }}>
                <button
                  className="btn primary"
                  disabled={creating}
                  onClick={async () => {
                    const paths = await api.system.pickMaterials()
                    if (paths.length) await start(paths)
                  }}
                  data-testid="welcome-open-folder"
                >
                  <Icon name="folderPlus" size={14} /> Open a folder
                </button>
                <button className="btn" disabled={creating} onClick={() => void start([])} data-testid="welcome-new-class">
                  Start without materials
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
      {/*
        The show button floats over the header, which drags the window. Electron
        applies drag and no-drag areas in document order, so it must come after
        the headers or real clicks drag the window instead of pressing it.
      */}
      {!sidebarOpen && (
        <button
          className={`icon-btn sidebar-toggle sidebar-reopen ${updateWaiting ? 'has-dot' : ''}`}
          onClick={() => setSidebarOpen(true)}
          title={`Show the sidebar (${shortcutLabel('toggleSidebar')})${updateWaiting ? ': an update is ready' : ''}`}
          aria-label="Show the sidebar"
          data-testid="sidebar-expand"
        >
          <Icon name="sidebarLeft" size={15} />
        </button>
      )}
      <Toasts />
      <FocusHost />
    </div>
  )
}
