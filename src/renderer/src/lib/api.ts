import { USER_ERROR_PREFIX, type MintApi } from '@shared/api'

export const api: MintApi = window.mint

/** Extract the human message from an IPC error ("Error invoking remote method 'x': Error: mint:..."). */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const idx = raw.indexOf(USER_ERROR_PREFIX)
  if (idx >= 0) return raw.slice(idx + USER_ERROR_PREFIX.length).trim()
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim() || 'Something went wrong.'
}

let counter = 0
export function newStreamId(): string {
  counter += 1
  return `s${Date.now().toString(36)}${counter}`
}

export function timeAgo(iso: string | undefined): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(iso).toLocaleDateString()
}

export function dueLabel(iso: string | undefined): string {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - Date.now()
  const d = Math.round(diff / 86_400_000)
  if (diff <= 0) return 'due now'
  if (d <= 0) return 'due today'
  if (d === 1) return 'due tomorrow'
  return `due in ${d} days`
}
