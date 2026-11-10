import type { JSX } from 'react'
import { useApp } from '../state/app'

/** Shows what the tutor is doing in the background ("Planning your curriculum…"). */
export function Activity({ classId }: { classId?: string }): JSX.Element | null {
  const { jobs } = useApp()
  const mine = classId ? jobs.filter((j) => j.classId === classId) : jobs
  if (!mine.length) return null
  const latest = mine[mine.length - 1]
  return (
    <div className="activity" data-testid="activity" title={mine.map((j) => j.label).join('\n')}>
      <span className="spinner" />
      <span className="ellipsis">{latest.label}…</span>
      {mine.length > 1 && <span className="muted">+{mine.length - 1}</span>}
    </div>
  )
}
