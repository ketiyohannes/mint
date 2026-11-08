import { useEffect, useRef, useState, type JSX } from 'react'
import { LAST_CLASS_KEY, useApp } from './state/app'
import { useClassBundle } from './state/useClass'
import { IS_MAC, Sidebar, SIDEBAR_SHORTCUT } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { SettingsView } from './views/SettingsView'
import { Workspace } from './views/Workspace'
import { Icon } from './components/Icon'
import { api } from './lib/api'
import { useUpdates } from './lib/useUpdates'
import { useDarkTheme } from './lib/useDarkTheme'
import { ErrorBoundary } from './components/ErrorBoundary'

const SIDEBAR_KEY = 'mint.sidebar'

export function App(): JSX.Element {
  const { route, go, classes, run, refreshClasses } = useApp()
  const classId = route.name === 'class' ? route.classId : null
  const loaded = useClassBundle(classId)
  // Never hand the previous class's bundle to the next class while it loads.
  const bundle = loaded.bundle && loaded.bundle.meta.id === classId ? loaded.bundle : null
  const error = loaded.error
  const [creating, setCreating] = useState(false)

  // The sidebar folds away for more room, like a code editor's (⌘B / Ctrl+B).
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== 'hidden')
  useEffect(() => localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? 'shown' : 'hidden'), [sidebarOpen])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'b' || !(IS_MAC ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return
      // Rich-text editors (notes) keep the key for bold.
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return
      e.preventDefault()
      setSidebarOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
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
          title={`Show the sidebar (${SIDEBAR_SHORTCUT})${updateWaiting ? ': an update is ready' : ''}`}
          aria-label="Show the sidebar"
          data-testid="sidebar-expand"
        >
          <Icon name="sidebarLeft" size={15} />
        </button>
      )}
      <Toasts />
    </div>
  )
}
