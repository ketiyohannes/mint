import {
  CHECK_KINDS,
  type CheckKind,
  type Curriculum,
  type HelpEvent,
  type IndependenceLevel,
  type IndependenceState,
  type Rung,
  type Session,
  type TopicProgress,
  type TopicStatus
} from '@shared/types'
import { allTopics } from '@shared/curriculum'

/**
 * Deterministic learning rules. Models judge individual answers; these
 * functions decide what that evidence means for progress, so the learner can
 * always be told exactly why something changed.
 */

/** Spaced-review ladder in days (storage strength over fluency). */
export const REVIEW_DAYS = [1, 3, 7, 14, 30, 60]

const DAY_MS = 24 * 60 * 60 * 1000

export function emptyProgress(topicId: string): TopicProgress {
  return {
    topicId,
    status: 'locked',
    checks: { explain: { passed: false }, apply: { passed: false }, distinguish: { passed: false } },
    reviewStage: 0
  }
}

export function isMastered(p: TopicProgress | undefined): boolean {
  return Boolean(p && CHECK_KINDS.every((k) => p.checks[k].passed))
}

/**
 * Recompute every topic's status from the curriculum and recorded evidence.
 * A topic is available once all its prerequisites are mastered.
 */
export function recomputeProgress(curriculum: Curriculum | null, existing: Record<string, TopicProgress>): Record<string, TopicProgress> {
  const out: Record<string, TopicProgress> = {}
  const topics = allTopics(curriculum)
  for (const topic of topics) out[topic.id] = { ...(existing[topic.id] ?? emptyProgress(topic.id)) }
  for (const topic of topics) {
    const p = out[topic.id]
    let status: TopicStatus
    if (isMastered(p)) status = 'mastered'
    else if (!topic.prerequisites.every((pre) => isMastered(out[pre]))) status = p.lastStudiedAt ? 'in-progress' : 'locked'
    else status = p.lastStudiedAt || CHECK_KINDS.some((k) => p.checks[k].passed) ? 'in-progress' : 'available'
    p.status = status
  }
  return out
}

/**
 * Zone of proximal development, code side: the first unmastered topic whose
 * prerequisites are all mastered, preferring one already in progress.
 */
export function nextTopicId(curriculum: Curriculum | null, progress: Record<string, TopicProgress>): string | null {
  const topics = allTopics(curriculum)
  const inProgress = topics.find((t) => progress[t.id]?.status === 'in-progress' && t.prerequisites.every((p) => isMastered(progress[p])))
  if (inProgress) return inProgress.id
  return topics.find((t) => progress[t.id]?.status === 'available')?.id ?? null
}

export function reviewsDue(progress: Record<string, TopicProgress>, now = new Date()): string[] {
  return Object.values(progress)
    .filter((p) => p.status === 'mastered' && p.nextReviewAt && new Date(p.nextReviewAt).getTime() <= now.getTime())
    .sort((a, b) => (a.nextReviewAt ?? '').localeCompare(b.nextReviewAt ?? ''))
    .map((p) => p.topicId)
}

/**
 * Apply one judged check to a topic. Returns the updated progress.
 * - Learn sessions: a pass marks that check; when all three pass the topic is
 *   mastered and the first review is scheduled.
 * - Review sessions: passing every check in the session promotes the review
 *   stage; any fail resets the stage (but keeps mastery, since the learner
 *   once demonstrated it) and schedules a sooner review.
 */
export function applyCheck(p: TopicProgress, kind: CheckKind, passed: boolean, session: Session, now = new Date()): TopicProgress {
  const next: TopicProgress = { ...p, checks: { ...p.checks }, lastStudiedAt: now.toISOString() }
  if (session.type === 'learn') {
    if (passed) next.checks[kind] = { passed: true, at: now.toISOString(), sessionId: session.id }
    if (CHECK_KINDS.every((k) => next.checks[k].passed) && !next.nextReviewAt) {
      next.reviewStage = 0
      next.nextReviewAt = new Date(now.getTime() + REVIEW_DAYS[0] * DAY_MS).toISOString()
    }
  }
  return next
}

/** Called when a review session finishes. */
export function applyReviewOutcome(p: TopicProgress, allPassed: boolean, now = new Date()): TopicProgress {
  const stage = allPassed ? Math.min(p.reviewStage + 1, REVIEW_DAYS.length - 1) : 0
  return {
    ...p,
    reviewStage: stage,
    lastStudiedAt: now.toISOString(),
    nextReviewAt: new Date(now.getTime() + REVIEW_DAYS[stage] * DAY_MS).toISOString()
  }
}

// ---------------------------------------------------------------------------
// Independence: the measure behind "the more I use it, the less I need it".
// ---------------------------------------------------------------------------

// New learners start at a hint (a full explanation is one deliberate click away);
// as independence grows the tutor starts lower on the ladder.
const LEVEL_DEFAULT_RUNG: Record<IndependenceLevel, Rung> = { 0: 3, 1: 2, 2: 1, 3: 1 }
const LEVEL_NAMES: Record<IndependenceLevel, string> = {
  0: 'Guided',
  1: 'Supported',
  2: 'Coached',
  3: 'Independent'
}

export function levelName(level: IndependenceLevel): string {
  return LEVEL_NAMES[level]
}

/**
 * Score in [0,1] from the last 20 asks: how little help each ask needed
 * (rung 1 = full credit, rung 4 = none), blended with how many judged checks
 * passed on the first attempt. Levels only move after enough evidence, so one
 * lucky or unlucky session does not swing support.
 */
export function computeIndependence(helpEvents: HelpEvent[], sessions: Session[], history: { at: string; score: number }[]): IndependenceState {
  // The final rung reached per thread-ask is what counts, not every click.
  const finalByAsk = new Map<string, HelpEvent>()
  for (const e of helpEvents) finalByAsk.set(e.escalated ? `${e.threadId}:${lastAskKey(helpEvents, e)}` : `${e.threadId}:${e.id}`, e)
  const asks = [...finalByAsk.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-20)

  const attempts = sessions.flatMap((s) => s.attempts).filter((a) => a.verdict)
  const recentAttempts = attempts.slice(-12)

  const helpScore = asks.length ? asks.reduce((sum, e) => sum + (4 - e.rung) / 3, 0) / asks.length : 0
  const checkScore = recentAttempts.length ? recentAttempts.filter((a) => a.verdict?.result === 'pass').length / recentAttempts.length : 0

  const evidence = asks.length + recentAttempts.length
  let score: number
  if (asks.length && recentAttempts.length) score = 0.6 * helpScore + 0.4 * checkScore
  else if (asks.length) score = helpScore
  else score = checkScore * 0.8

  let level: IndependenceLevel = 0
  if (evidence >= 5) level = score >= 0.75 ? 3 : score >= 0.55 ? 2 : score >= 0.35 ? 1 : 0
  if (evidence >= 5 && evidence < 10 && level > 2) level = 2 // full independence needs more evidence

  const reason =
    evidence < 5
      ? `Not enough evidence yet (${evidence} of 5 asks or checks). Support stays generous until mint knows you better.`
      : `Over your last ${asks.length} question${asks.length === 1 ? '' : 's'} you needed ${describeAvgRung(asks)} on average` +
        (recentAttempts.length ? `, and passed ${Math.round(checkScore * 100)}% of ${recentAttempts.length} recent checks` : '') +
        `. So the tutor now starts with: ${rungStart(LEVEL_DEFAULT_RUNG[level])}.`

  return {
    level,
    score: Math.round(score * 100) / 100,
    defaultRung: LEVEL_DEFAULT_RUNG[level],
    reason,
    history,
    asks: asks.length
  }
}

function lastAskKey(events: HelpEvent[], e: HelpEvent): string {
  // An escalation belongs to the most recent non-escalated ask on the same thread.
  const prior = events.filter((x) => x.threadId === e.threadId && !x.escalated && x.at <= e.at)
  return prior.length ? prior[prior.length - 1].id : e.id
}

function describeAvgRung(asks: HelpEvent[]): string {
  if (!asks.length) return 'no help'
  const avg = asks.reduce((s, e) => s + e.rung, 0) / asks.length
  if (avg < 1.5) return 'only a pointer'
  if (avg < 2.5) return 'a guiding question'
  if (avg < 3.5) return 'a hint'
  return 'a full explanation'
}

function rungStart(r: Rung): string {
  return { 1: 'a pointer to the passage', 2: 'a guiding question', 3: 'a hint', 4: 'a full explanation' }[r]
}

export function appendHistory(history: { at: string; score: number }[], score: number, now = new Date()): { at: string; score: number }[] {
  const last = history[history.length - 1]
  if (last && last.score === score && now.getTime() - new Date(last.at).getTime() < 60 * 60 * 1000) return history
  return [...history, { at: now.toISOString(), score }].slice(-120)
}
