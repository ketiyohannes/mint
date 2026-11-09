import { useSyncExternalStore } from 'react'
import { IDLE_FOCUS, type FocusState } from '@shared/focus'

/**
 * The focus timer's state and today's tally, kept in localStorage so a
 * running block survives a reload or a restart (it is a deadline, not a
 * counter). One store for the whole app; any view can show it.
 */
const STATE_KEY = 'mint.focus.state'
const TODAY_KEY = 'mint.focus.today'

export interface FocusDay {
  /** Local date, YYYY-MM-DD. */
  day: string
  blocks: number
  minutes: number
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function readState(): FocusState {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as Partial<FocusState> | null
    if (s && ['focus', 'short', 'long'].includes(s.phase as string) && isNum(s.done) && (s.endsAt === null || isNum(s.endsAt)) && (s.left === null || isNum(s.left))) {
      return s as FocusState
    }
  } catch {
    // Unreadable: start fresh.
  }
  return IDLE_FOCUS
}

function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function readToday(): FocusDay {
  const day = localDay()
  try {
    const t = JSON.parse(localStorage.getItem(TODAY_KEY) ?? 'null') as Partial<FocusDay> | null
    if (t?.day === day && isNum(t.blocks) && isNum(t.minutes)) return t as FocusDay
  } catch {
    // Unreadable: count from zero.
  }
  return { day, blocks: 0, minutes: 0 }
}

let state = readState()
let today = readToday()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function focusState(): FocusState {
  return state
}

export function setFocusState(next: FocusState): void {
  if (next === state) return
  state = next
  localStorage.setItem(STATE_KEY, JSON.stringify(state))
  listeners.forEach((l) => l())
}

export function useFocusState(): FocusState {
  return useSyncExternalStore(subscribe, focusState)
}

/** Adds a finished focus block to today's tally (a new day starts from zero). */
export function logFocusBlock(minutes: number): void {
  const current = readToday()
  today = { ...current, blocks: current.blocks + 1, minutes: current.minutes + minutes }
  localStorage.setItem(TODAY_KEY, JSON.stringify(today))
  listeners.forEach((l) => l())
}

export function useFocusToday(): FocusDay {
  return useSyncExternalStore(subscribe, () => {
    // Roll over at midnight without a write.
    if (today.day !== localDay()) today = readToday()
    return today
  })
}

let audio: AudioContext | null = null

/**
 * Wakes the audio output while the learner is pressing a button, so a chime
 * that plays later, without a gesture, is allowed to sound.
 */
export function primeChime(): void {
  audio ??= new AudioContext()
  void audio.resume().catch(() => undefined)
}

/** A soft two-note bell, synthesized so no sound file ships with the app. */
export function chime(): void {
  try {
    audio ??= new AudioContext()
    void audio.resume().catch(() => undefined)
    const t0 = audio.currentTime + 0.02
    ;[660, 880].forEach((freq, i) => {
      const osc = audio!.createOscillator()
      const gain = audio!.createGain()
      const t = t0 + i * 0.18
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7)
      osc.connect(gain).connect(audio!.destination)
      osc.start(t)
      osc.stop(t + 0.75)
    })
  } catch {
    // No audio output: the toast and the notification still tell.
  }
}
