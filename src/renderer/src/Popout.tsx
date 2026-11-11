import { useEffect, type JSX } from 'react'
import type { PopoutKind } from '@shared/types'
import { useClassBundle } from './state/useClass'
import { api } from './lib/api'
import { usePopouts, usePopoutsKnown } from './lib/windows'
import { Toasts } from './components/Toasts'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Workspace } from './views/Workspace'

const NAME: Record<PopoutKind, string> = { lesson: 'Lesson', panel: 'Sources and notes' }

/**
 * A part of a class in a window of its own: the lesson, or the panel. It shows
 * whichever class the main window is on. Everything it does goes through the
 * main process, like the main window, so the two never disagree.
 */
export function Popout({ view }: { view: PopoutKind }): JSX.Element {
  const classId = usePopouts()[view]
  const known = usePopoutsKnown()
  const { bundle: loaded, error } = useClassBundle(classId)
  const bundle = loaded && loaded.meta.id === classId ? loaded : null

  // Its class is gone (deleted in the main window): so is this window.
  useEffect(() => {
    if (error) void api.windows.attach(view).catch(() => undefined)
  }, [error, view])

  const title = bundle?.meta.title
  useEffect(() => {
    document.title = title ? `${title} · ${NAME[view]}` : NAME[view]
  }, [title, view])

  return (
    <div className="app popout">
      <main className="main">
        {bundle ? (
          <ErrorBoundary key={bundle.meta.id} label="this window">
            <Workspace bundle={bundle} chatId={undefined} view={view} />
          </ErrorBoundary>
        ) : (
          // A window whose part went back to the main window is on its way out.
          <div className="empty">{error ?? (known && !classId ? '' : <span className="spinner" />)}</div>
        )}
      </main>
      <Toasts />
    </div>
  )
}
