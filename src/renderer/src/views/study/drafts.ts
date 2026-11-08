import { useSyncExternalStore } from 'react'
import type { CheckKind } from '@shared/types'

/**
 * Answers being written in a lesson's study box, by lesson, so a chat message
 * can carry the unsent answer to the tutor ("is my answer on track?").
 */
const drafts = new Map<string, { kind: CheckKind; text: string }>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

export function setCheckDraft(sessionId: string, kind: CheckKind, text: string): void {
  const had = drafts.has(sessionId)
  if (text.trim()) drafts.set(sessionId, { kind, text })
  else drafts.delete(sessionId)
  if (had !== drafts.has(sessionId)) notify()
}

export function clearCheckDraft(sessionId: string, kind: CheckKind): void {
  if (drafts.get(sessionId)?.kind !== kind) return
  drafts.delete(sessionId)
  notify()
}

export function checkDraft(sessionId: string | undefined): { kind: CheckKind; text: string } | undefined {
  return sessionId ? drafts.get(sessionId) : undefined
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether a lesson has an unsent answer (re-renders only when that changes). */
export function useHasDraft(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => drafts.has(sessionId))
}
