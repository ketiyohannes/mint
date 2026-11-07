import type { CheckKind } from '@shared/types'

/**
 * Answers being written in a lesson's study box, by lesson, so a chat message
 * can carry the unsent answer to the tutor ("is my answer on track?").
 */
const drafts = new Map<string, { kind: CheckKind; text: string }>()

export function setCheckDraft(sessionId: string, kind: CheckKind, text: string): void {
  if (text.trim()) drafts.set(sessionId, { kind, text })
  else drafts.delete(sessionId)
}

export function clearCheckDraft(sessionId: string, kind: CheckKind): void {
  if (drafts.get(sessionId)?.kind === kind) drafts.delete(sessionId)
}

export function checkDraft(sessionId: string | undefined): { kind: CheckKind; text: string } | undefined {
  return sessionId ? drafts.get(sessionId) : undefined
}
