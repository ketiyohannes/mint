import { describe, expect, it } from 'vitest'
import { DEFAULT_FOCUS, IDLE_FOCUS, advance, clock, pause, remaining, sanitizeFocus, start, type FocusSpec } from '../../src/shared/focus'

const spec: FocusSpec = { ...DEFAULT_FOCUS, focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, rounds: 2 }
const MIN = 60_000

describe('focus timer', () => {
  it('runs a block to a deadline, and pausing keeps the time left', () => {
    const running = start(IDLE_FOCUS, spec, 0)
    expect(running.endsAt).toBe(25 * MIN)
    expect(remaining(running, spec, 10 * MIN)).toBe(15 * MIN)
    const paused = pause(running, spec, 10 * MIN)
    expect(paused).toMatchObject({ endsAt: null, left: 15 * MIN })
    // An hour away changes nothing while paused.
    expect(remaining(paused, spec, 70 * MIN)).toBe(15 * MIN)
    expect(start(paused, spec, 70 * MIN).endsAt).toBe(85 * MIN)
    expect(start(running, spec, 5 * MIN)).toBe(running) // already running
  })

  it('alternates focus and short breaks, with a long break that starts a new cycle', () => {
    let s = advance(start(IDLE_FOCUS, spec, 0), spec, 25 * MIN, false)
    expect(s).toEqual({ phase: 'short', done: 1, endsAt: null, left: null })
    s = advance(s, spec, 30 * MIN, true)
    expect(s).toEqual({ phase: 'focus', done: 1, endsAt: 55 * MIN, left: null })
    s = advance(s, spec, 55 * MIN, true)
    expect(s).toMatchObject({ phase: 'long', done: 2, endsAt: 70 * MIN })
    s = advance(s, spec, 70 * MIN, false)
    expect(s).toEqual({ phase: 'focus', done: 0, endsAt: null, left: null })
    expect(remaining(s, spec, 70 * MIN)).toBe(25 * MIN)
  })

  it('shows minutes and seconds, rounding up until the very end', () => {
    expect(clock(25 * MIN)).toBe('25:00')
    expect(clock(61_001)).toBe('1:02')
    expect(clock(999)).toBe('0:01')
    expect(clock(0)).toBe('0:00')
  })

  it('keeps the rhythm within sensible bounds and fills gaps with defaults', () => {
    expect(sanitizeFocus(undefined)).toEqual(DEFAULT_FOCUS)
    expect(sanitizeFocus({ focusMinutes: 500, shortBreakMinutes: 0, longBreakMinutes: '20', rounds: 3.6, autoStart: 'yes', sound: false })).toEqual({
      focusMinutes: 120,
      shortBreakMinutes: 1,
      longBreakMinutes: 20,
      rounds: 4,
      autoStart: false,
      sound: false
    })
  })

  it('is saved with the settings, sanitized', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { SettingsStore } = await import('../../src/main/store/settingsStore')
    const dir = mkdtempSync(join(tmpdir(), 'mint-focus-'))
    const store = new SettingsStore(dir, { available: () => true, encrypt: (p) => p, decrypt: (c) => c })
    expect((await store.get()).focus).toEqual(DEFAULT_FOCUS)
    await store.update({ focus: { ...DEFAULT_FOCUS, focusMinutes: 50, rounds: 99 } })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).focus).toMatchObject({ focusMinutes: 50, rounds: 8 })
  })
})
