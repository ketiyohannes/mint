import type { JSX } from 'react'
import { useApp } from '../state/app'
import { Icon } from './Icon'

export function Toasts(): JSX.Element {
  const { toasts, dismiss } = useApp()
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`} data-testid={t.kind === 'error' ? 'toast-error' : 'toast'}>
          <span>{t.text}</span>
          <button className="btn ghost sm icon close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
