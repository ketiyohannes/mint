import { useSyncExternalStore } from 'react'
import type { CheckKind } from '@shared/types'

/**
 * Answers being written in a lesson's study box, by lesson and check. Kept
 * while the box is off screen (another step, the dock closed, the lesson moved
 * to the Study tab or to its own window, another class, a restart), so a
 * half-written answer is there on the way back; dropped once the check is
 * passed or the lesson ends. They live in localStorage, which every window
 * shares: the chat in the main window sees an answer being written in the
 * lesson's own window.
 */
const KEY = 'mint.checkDrafts'
/** Lessons left unfinished long ago do not keep their drafts forever. */
const MAX_LESSONS = 30
const drafts = new Map<string, Partial<Record<CheckKind, string>>>()
/** The check showing in each lesson: its draft is the one a chat message carries to the tutor. */
const showing = new Map<string, CheckKind>()
const listeners = new Set<() => void>()
const shared = typeof window !== 'undefined'

function notify(): void {
  for (const l of listeners) l()
}

function load(): void {
  drafts.clear()
  showing.clear()
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { drafts?: Record<string, Partial<Record<CheckKind, string>>>; showing?: Record<string, CheckKind> } | null
    for (const [id, mine] of Object.entries(stored?.drafts ?? {})) if (mine && typeof mine === 'object') drafts.set(id, mine)
    for (const [id, kind] of Object.entries(stored?.showing ?? {})) if (typeof kind === 'string') showing.set(id, kind)
  } catch {
    // Unreadable: no drafts.
  }
}

function save(): void {
  if (!shared) return
  while (drafts.size > MAX_LESSONS) drafts.delete(drafts.keys().next().value!)
  try {
    localStorage.setItem(KEY, JSON.stringify({ drafts: Object.fromEntries(drafts), showing: Object.fromEntries(showing) }))
  } catch {
    // Storage full or unavailable: the drafts last as long as this window.
  }
}

if (shared) {
  load()
  // Written in another window.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    load()
    notify()
  })
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
  save()
  if (had !== Boolean(checkDraft(sessionId))) notify()
}

/** The check's box left the screen: its text is kept, but no longer shown to the tutors. */
export function hideCheckDraft(sessionId: string, kind: CheckKind): void {
  if (showing.get(sessionId) !== kind) return
  const had = Boolean(checkDraft(sessionId))
  showing.delete(sessionId)
  save()
  if (had) notify()
}

/** The lesson ended: nothing of it is left to finish. */
export function clearSessionDrafts(sessionId: string): void {
  const had = Boolean(checkDraft(sessionId))
  drafts.delete(sessionId)
  showing.delete(sessionId)
  save()
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
