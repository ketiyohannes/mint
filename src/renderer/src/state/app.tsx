import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ClassSummary, ProgressEvent, SettingsView } from '@shared/types'
import { api, errorMessage } from '../lib/api'

export type ClassTab = 'path' | 'study' | 'library' | 'notebook' | 'progress'

export type Route =
  | { name: 'home' }
  | { name: 'new-class' }
  | { name: 'settings' }
  | { name: 'class'; classId: string; tab: ClassTab }

export interface Toast {
  id: number
  kind: 'info' | 'error'
  text: string
}

export interface StudyFocus {
  /** Open this source, jump to section/quote. */
  sourceId: string
  section?: string
  quote?: string
  /** Bump to re-trigger the same jump. */
  nonce: number
}

interface AppState {
  route: Route
  go(route: Route): void
  settings: SettingsView | null
  setSettings(s: SettingsView): void
  classes: ClassSummary[]
  refreshClasses(): Promise<void>
  toasts: Toast[]
  toast(text: string, kind?: Toast['kind']): void
  dismiss(id: number): void
  jobs: ProgressEvent[]
  /** Run an action, reporting errors as toasts. Returns undefined on failure. */
  run<T>(fn: () => Promise<T>, okMessage?: string): Promise<T | undefined>
  studyFocus: StudyFocus | null
  focusSource(classId: string, focus: Omit<StudyFocus, 'nonce'>): void
}

const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside AppProvider')
  return v
}

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [route, setRoute] = useState<Route>({ name: 'home' })
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [classes, setClasses] = useState<ClassSummary[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [jobs, setJobs] = useState<ProgressEvent[]>([])
  const [studyFocus, setStudyFocus] = useState<StudyFocus | null>(null)
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
      setClasses(await api.classes.list())
    } catch (err) {
      toast(errorMessage(err), 'error')
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
    void api.settings.get().then(setSettings)
    void refreshClasses()
    const offChanged = api.on.classChanged(() => void refreshClasses())
    const offProgress = api.on.progress((e) => {
      setJobs((list) => {
        const others = list.filter((j) => j.jobId !== e.jobId)
        return e.state === 'running' ? [...others, e] : others
      })
    })
    return () => {
      offChanged()
      offProgress()
    }
  }, [refreshClasses])

  // Theme
  useEffect(() => {
    const pref = settings?.theme ?? 'light'
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = pref === 'dark' || (pref === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings?.theme])

  const go = useCallback((r: Route) => {
    setRoute(r)
    if (r.name === 'class') void api.classes.activate(r.classId).catch(() => undefined)
  }, [])

  const focusSource = useCallback(
    (classId: string, focus: Omit<StudyFocus, 'nonce'>) => {
      setStudyFocus({ ...focus, nonce: Date.now() })
      setRoute({ name: 'class', classId, tab: 'study' })
    },
    []
  )

  const value = useMemo<AppState>(
    () => ({ route, go, settings, setSettings, classes, refreshClasses, toasts, toast, dismiss, jobs, run, studyFocus, focusSource }),
    [route, go, settings, classes, refreshClasses, toasts, toast, dismiss, jobs, run, studyFocus, focusSource]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
