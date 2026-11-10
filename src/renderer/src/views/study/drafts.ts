import { useSyncExternalStore } from 'react'
import type { CheckKind } from '@shared/types'

/**
 * Answers being written in a lesson's study box, by lesson and check. Kept
 * while the box is off screen (another step, the dock closed, the lesson moved
 * to the Study tab, another class), so a half-written answer is there on the
 * way back; dropped once the check is passed or the lesson ends.
 */
const drafts = new Map<string, Partial<Record<CheckKind, string>>>()
/** The check showing in each lesson: its draft is the one a chat message carries to the tutor. */
const showing = new Map<string, CheckKind>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

/** The answer in the box of the check that is showing ("is my answer on track?"). */
export function checkDraft(sessionId: string | undefined): { kind: CheckKind; text: string } | undefined {
  const kind = sessionId ? showing.get(sessionId) : undefined
  const text = sessionId && kind ? drafts.get(sessionId)?.[kind] : undefined
  return kind && text ? { kind, text } : undefined
}

/** What was last written for a check, to fill its box again. */
export function savedDraft(sessionId: string, kind: CheckKind): string {
  return drafts.get(sessionId)?.[kind] ?? ''
}

/** The check's box is on screen with this text in it. */
export function setCheckDraft(sessionId: string, kind: CheckKind, text: string): void {
  const had = Boolean(checkDraft(sessionId))
  const mine = { ...drafts.get(sessionId) }
  if (text.trim()) mine[kind] = text
  else delete mine[kind]
  if (Object.keys(mine).length) drafts.set(sessionId, mine)
  else drafts.delete(sessionId)
  showing.set(sessionId, kind)
  if (had !== Boolean(checkDraft(sessionId))) notify()
}

/** The check's box left the screen: its text is kept, but no longer shown to the tutors. */
export function hideCheckDraft(sessionId: string, kind: CheckKind): void {
  if (showing.get(sessionId) !== kind) return
  const had = Boolean(checkDraft(sessionId))
  showing.delete(sessionId)
  if (had) notify()
}

/** The lesson ended: nothing of it is left to finish. */
export function clearSessionDrafts(sessionId: string): void {
  const had = Boolean(checkDraft(sessionId))
  drafts.delete(sessionId)
  showing.delete(sessionId)
  if (had) notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether a lesson has an unsent answer in the box that is showing (re-renders only when that changes). */
export function useHasDraft(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => Boolean(checkDraft(sessionId)))
}
