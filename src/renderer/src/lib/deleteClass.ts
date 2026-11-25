import { useCallback } from 'react'
import { useApp } from '../state/app'
import { api } from './api'
import { clearClassDrafts } from './drafts'
import { forgetPositions } from '../views/study/position'
import { forgetQuickPosition } from '../views/QuickCoursePanel'
import { forgetBrowserPage } from '../views/BrowserPanel'

/**
 * Delete a class after asking, from wherever it is listed. What this window
 * kept about it (drafts, reading positions) goes with it, and when it was the
 * class that is open, another one opens in its place.
 */
export function useDeleteClass(): (target: { id: string; title: string }) => Promise<void> {
  const { route, classes, go, run } = useApp()
  return useCallback(
    async ({ id, title }) => {
      if (!window.confirm(`Delete "${title}" and everything in it? This cannot be undone.`)) return
      const ok = await run(async () => {
        await api.classes.remove(id)
        return true
      })
      if (!ok) return
      clearClassDrafts(id)
      forgetPositions(id)
      forgetQuickPosition(id)
      forgetBrowserPage(id)
      if (route.name !== 'class' || route.classId !== id) return
      const next = classes.find((c) => c.id !== id)
      go(next ? { name: 'class', classId: next.id } : { name: 'home' })
    },
    [route, classes, go, run]
  )
}
