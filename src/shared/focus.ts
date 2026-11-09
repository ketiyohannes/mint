/**
 * The focus timer (Pomodoro): focus blocks with short breaks between them and
 * a long break after every few blocks. Pure state transitions over epoch
 * milliseconds, so the renderer can persist the state and pick it up again
 * after a reload or a restart.
 */

/** The learner's rhythm, kept in Settings. */
export interface FocusSpec {
  focusMinutes: number
  shortBreakMinutes: number
  longBreakMinutes: number
  /** Focus blocks before a long break. */
  rounds: number
  /** Start the next block as soon as one ends, instead of waiting for Start. */
  autoStart: boolean
  /** Chime when a block ends. */
  sound: boolean
}

export const DEFAULT_FOCUS: FocusSpec = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, rounds: 4, autoStart: false, sound: true }

/** Allowed range for each number in the spec. */
export const FOCUS_LIMITS = {
  focusMinutes: [5, 120],
  shortBreakMinutes: [1, 30],
  longBreakMinutes: [5, 60],
  rounds: [2, 8]
} as const satisfies Record<string, readonly [number, number]>

export type FocusNumber = keyof typeof FOCUS_LIMITS

export function sanitizeFocus(input: unknown): FocusSpec {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof FocusSpec, unknown>>
  const num = (key: FocusNumber): number => {
    const [min, max] = FOCUS_LIMITS[key]
    const n = Number(raw[key])
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULT_FOCUS[key]
  }
  return {
    focusMinutes: num('focusMinutes'),
    shortBreakMinutes: num('shortBreakMinutes'),
    longBreakMinutes: num('longBreakMinutes'),
    rounds: num('rounds'),
    autoStart: typeof raw.autoStart === 'boolean' ? raw.autoStart : DEFAULT_FOCUS.autoStart,
    sound: typeof raw.sound === 'boolean' ? raw.sound : DEFAULT_FOCUS.sound
  }
}

export type FocusPhase = 'focus' | 'short' | 'long'

export const PHASE_NAME: Record<FocusPhase, string> = { focus: 'Focus', short: 'Short break', long: 'Long break' }

/**
 * Running when `endsAt` is set, paused when `left` is set, otherwise ready to
 * start the phase from its full length.
 */
export interface FocusState {
  phase: FocusPhase
  endsAt: number | null
  left: number | null
  /** Focus blocks finished in this cycle; the long break starts a new cycle. */
  done: number
}

export const IDLE_FOCUS: FocusState = { phase: 'focus', endsAt: null, left: null, done: 0 }

export function phaseLength(spec: FocusSpec, phase: FocusPhase): number {
  const minutes = phase === 'focus' ? spec.focusMinutes : phase === 'short' ? spec.shortBreakMinutes : spec.longBreakMinutes
  return minutes * 60_000
}

export function remaining(state: FocusState, spec: FocusSpec, now: number): number {
  if (state.endsAt !== null) return Math.max(0, state.endsAt - now)
  return state.left ?? phaseLength(spec, state.phase)
}

export function isRunning(state: FocusState): boolean {
  return state.endsAt !== null
}

export function start(state: FocusState, spec: FocusSpec, now: number): FocusState {
  if (state.endsAt !== null) return state
  return { ...state, endsAt: now + remaining(state, spec, now), left: null }
}

export function pause(state: FocusState, spec: FocusSpec, now: number): FocusState {
  if (state.endsAt === null) return state
  return { ...state, endsAt: null, left: remaining(state, spec, now) }
}

/**
 * Moves to the next phase, as when the current one ends (or is skipped): a
 * focus block leads to a short break, or a long one when the cycle is full; a
 * long break starts a new cycle. `run` starts the next phase right away.
 */
export function advance(state: FocusState, spec: FocusSpec, now: number, run: boolean): FocusState {
  let phase: FocusPhase
  let done = state.done
  if (state.phase === 'focus') {
    done += 1
    phase = done >= spec.rounds ? 'long' : 'short'
  } else {
    phase = 'focus'
    if (state.phase === 'long') done = 0
  }
  return { phase, done, left: null, endsAt: run ? now + phaseLength(spec, phase) : null }
}

/** Formats milliseconds left as m:ss, rounding up so 0:00 only shows at the end. */
export function clock(ms: number): string {
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
