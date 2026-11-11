import { CHECK_KINDS, type CheckKind, type Phase, type Session } from './types'

/**
 * How far a lesson goes after the reading. Every lesson has the brief, the
 * reading, the Explain check and the wrap-up; the deeper settings add the
 * Apply and Distinguish checks. A topic is mastered once it has passed the
 * checks its lessons asked for.
 */
export type StudyDepth = 'quick' | 'standard' | 'thorough'

export const DEFAULT_STUDY_DEPTH: StudyDepth = 'thorough'

export const STUDY_DEPTHS: readonly { id: StudyDepth; label: string; checks: readonly CheckKind[]; hint: string }[] = [
  { id: 'quick', label: 'Quick', checks: ['explain'], hint: 'Read, then explain it in your own words.' },
  { id: 'standard', label: 'Standard', checks: ['explain', 'apply'], hint: 'Explain it, then use it on a new case.' },
  { id: 'thorough', label: 'Thorough', checks: ['explain', 'apply', 'distinguish'], hint: 'Explain it, use it on a new case, and tell it apart from nearby ideas.' }
]

/** What each step of a lesson is called. */
export const PHASE_LABEL: Record<Phase, string> = { brief: 'Brief', read: 'Read', explain: 'Explain', apply: 'Apply', distinguish: 'Distinguish', wrap: 'Wrap up' }

export function isStudyDepth(value: unknown): value is StudyDepth {
  return STUDY_DEPTHS.some((d) => d.id === value)
}

export function depthChecks(depth: StudyDepth): readonly CheckKind[] {
  return (STUDY_DEPTHS.find((d) => d.id === depth) ?? STUDY_DEPTHS[STUDY_DEPTHS.length - 1]).checks
}

/**
 * The checks a lesson has: the ones the depth asks for, plus any the learner
 * already opened in this lesson at a deeper setting (a step they are on, or
 * have answered, does not vanish when the setting changes).
 */
export function sessionChecks(session: Session, depth: StudyDepth): CheckKind[] {
  const wanted = depthChecks(depth)
  return CHECK_KINDS.filter((k) => wanted.includes(k) || session.phase === k || session.prompts[k] !== undefined || session.attempts.some((a) => a.kind === k))
}

/** A lesson's steps, in order. */
export function sessionPhases(session: Session, depth: StudyDepth): Phase[] {
  return ['brief', 'read', ...sessionChecks(session, depth), 'wrap']
}
