import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ClassSummary, ProgressEvent, SettingsView } from '@shared/types'
import { api, errorMessage } from '../lib/api'
import { sendToWindows, useWindowMessages } from '../lib/windows'

/**
 * `chatId: null` is a new chat (the centered prompt); omitted means "the latest chat".
 * Settings can open scrolled to one of its sections.
 */
export type Route = { name: 'home' } | { name: 'settings'; section?: 'shortcuts' } | { name: 'class'; classId: string; chatId?: string | null }

export interface Toast {
  id: number
  kind: 'info' | 'error'
  text: string
}

interface AppState {
  route: Route
  go(route: Route): void
  settings: SettingsView | null
  setSettings(s: SettingsView): void
  classes: ClassSummary[]
  /** False until the first list of classes has arrived (so "no classes" is not shown too early). */
  classesLoaded: boolean
  refreshClasses(): Promise<void>
  toasts: Toast[]
  toast(text: string, kind?: Toast['kind']): void
  dismiss(id: number): void
  jobs: ProgressEvent[]
  /** Run an action, reporting errors as toasts. Returns undefined on failure. */
  run<T>(fn: () => Promise<T>, okMessage?: string): Promise<T | undefined>
}

export const LAST_CLASS_KEY = 'mint.lastClass'
/** The theme last shown ('light' or 'dark'), so the next start paints it before Settings load. */
export const THEME_KEY = 'mint.theme'

const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside AppProvider')
  return v
}

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [route, setRoute] = useState<Route>({ name: 'home' })
  const [settings, applySettings] = useState<SettingsView | null>(null)
  const [classes, setClasses] = useState<ClassSummary[]>([])
  const [classesLoaded, setClassesLoaded] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [jobs, setJobs] = useState<ProgressEvent[]>([])
  const toastId = useRef(0)

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback(
    (text: string, kind: Toast['kind'] = 'info') => {
      const id = ++toastId.current
      setToasts((t) => [...t.slice(-2), { id, kind, text }])
      setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 4000)
    },
    [dismiss]
  )

  const refreshClasses = useCallback(async () => {
    try {
      // Stable order, like projects: newest first, never reshuffled by activity.
      setClasses((await api.classes.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setClassesLoaded(true)
    }
  }, [toast])

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okMessage?: string): Promise<T | undefined> => {
      try {
        const out = await fn()
        if (okMessage) toast(okMessage)
        return out
      } catch (err) {
        toast(errorMessage(err), 'error')
        return undefined
      }
    },
    [toast]
  )

  useEffect(() => {
    void api.settings.get().then(applySettings)
    void refreshClasses()
    const offChanged = api.on.classChanged(() => void refreshClasses())
    const offProgress = api.on.progress((e) => {
      if (e.notice && e.detail) toast(e.detail, 'error')
      setJobs((list) => {
        const others = list.filter((j) => j.jobId !== e.jobId)
        return e.state === 'running' ? [...others, e] : others
      })
    })
    return () => {
      offChanged()
      offProgress()
    }
  }, [refreshClasses, toast])

  // Theme. Until Settings load, the theme main.tsx painted (the last one shown) stays.
  useEffect(() => {
    const pref = settings?.theme
    if (!pref) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = pref === 'dark' || (pref === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      try {
        localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
      } catch {
        // The next start paints light first.
      }
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings?.theme])

  // Settings changed here are told to the other windows, which read them again (the theme, where lessons show).
  const setSettings = useCallback((s: SettingsView) => {
    applySettings(s)
    sendToWindows({ type: 'settings' })
  }, [])
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  useWindowMessages((m) => {
    if (m.type !== 'settings') return
    void api.settings
      .get()
      // The window that sent it hears it too, and has nothing to change.
      .then((s) => JSON.stringify(s) !== JSON.stringify(settingsRef.current) && applySettings(s))
      .catch(() => undefined)
  })

  const go = useCallback((r: Route) => {
    setRoute(r)
    if (r.name === 'class') localStorage.setItem(LAST_CLASS_KEY, r.classId)
  }, [])

  const value = useMemo<AppState>(
    () => ({ route, go, settings, setSettings, classes, classesLoaded, refreshClasses, toasts, toast, dismiss, jobs, run }),
    [route, go, settings, setSettings, classes, classesLoaded, refreshClasses, toasts, toast, dismiss, jobs, run]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
