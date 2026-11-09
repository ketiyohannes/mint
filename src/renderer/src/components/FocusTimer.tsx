import { useEffect, useRef, useState, type JSX } from 'react'
import {
  DEFAULT_FOCUS,
  FOCUS_LIMITS,
  IDLE_FOCUS,
  PHASE_NAME,
  advance,
  clock,
  isRunning,
  pause,
  phaseLength,
  remaining,
  start,
  type FocusNumber,
  type FocusSpec,
  type FocusState
} from '@shared/focus'
import { useApp } from '../state/app'
import { api } from '../lib/api'
import { chime, focusState, logFocusBlock, primeChime, setFocusState, useFocusState, useFocusToday } from '../lib/focusTimer'
import { Icon } from './Icon'

/** A block that ended this long ago ended while mint was closed or asleep: no chime for it. */
const LATE = 60_000

function useSpec(): FocusSpec {
  return useApp().settings?.focus ?? DEFAULT_FOCUS
}

/** Re-renders whenever the countdown's whole second changes, while a block runs. */
function useTick(endsAt: number | null): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (endsAt === null) return
    let timer: ReturnType<typeof setTimeout>
    const wait = () => {
      timer = setTimeout(
        () => {
          setTick((t) => t + 1)
          wait()
        },
        ((endsAt - Date.now()) % 1000 || 1000) + 5
      )
    }
    wait()
    return () => clearTimeout(timer)
  }, [endsAt])
}

function endMessage(ended: FocusState['phase'], next: FocusState, spec: FocusSpec): string {
  const len = `${phaseLength(spec, next.phase) / 60_000}-minute`
  if (ended === 'focus') {
    return next.phase === 'long' ? `${spec.rounds} focus blocks done. Take a ${len} long break.` : `Focus block done. Take a ${len} break.`
  }
  return next.endsAt !== null ? `Break over. Focusing for ${spec.focusMinutes} minutes.` : 'Break over. Start the next focus block when you are ready.'
}

/**
 * Ends blocks on time wherever the learner is in the app, with a toast, a
 * chime, and a system notification when mint is in the background. Mounted
 * once, at the top of the app. It waits on one timeout for the deadline: a
 * single timer is not throttled the way a repeating one is in a hidden window.
 */
export function FocusHost(): null {
  const { toast } = useApp()
  const spec = useSpec()
  const state = useFocusState()

  useEffect(() => {
    if (state.endsAt === null) return
    const endsAt = state.endsAt
    const finish = () => {
      // Handled already (the effect can run twice for one state).
      if (focusState() !== state) return
      const now = Date.now()
      const late = now - endsAt > LATE
      if (state.phase === 'focus') logFocusBlock(spec.focusMinutes)
      const next = advance(state, spec, now, spec.autoStart && !late)
      setFocusState(next)
      const text = endMessage(state.phase, next, spec)
      toast(text)
      if (late) return
      if (spec.sound) chime()
      if (!document.hasFocus()) {
        try {
          new Notification(state.phase === 'focus' ? 'Focus block done' : 'Break over', { body: text, silent: true })
        } catch {
          // Notifications unavailable: the toast is waiting in the app.
        }
      }
    }
    const wait = endsAt - Date.now()
    if (wait <= 0) return finish()
    const timer = setTimeout(finish, wait)
    return () => clearTimeout(timer)
  }, [state, spec, toast])

  return null
}

/**
 * The focus timer in the pane head: a button while idle, a live countdown
 * while a block runs, and a popover with the controls and the learner's
 * rhythm (block and break lengths).
 */
export function FocusTimer(): JSX.Element {
  const { setSettings, run } = useApp()
  const spec = useSpec()
  const state = useFocusState()
  const today = useFocusToday()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const running = isRunning(state)
  const paused = state.left !== null
  const pristine = !running && !paused && state.phase === 'focus' && state.done === 0
  useTick(state.endsAt)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const now = Date.now()
  const left = remaining(state, spec, now)
  const length = phaseLength(spec, state.phase)
  const done = Math.min(1, Math.max(0, 1 - left / length))
  const onBreak = state.phase !== 'focus'

  const toggle = () => {
    primeChime()
    setFocusState(running ? pause(state, spec, Date.now()) : start(state, spec, Date.now()))
  }
  const skip = () => setFocusState(advance(state, spec, Date.now(), running))
  const reset = () => setFocusState(IDLE_FOCUS)

  const setSpec = async (patch: Partial<FocusSpec>) => {
    const s = await run(() => api.settings.update({ focus: { ...spec, ...patch } }))
    if (s) setSettings(s)
  }

  const label = running || paused ? clock(left) : onBreak ? 'Break' : null
  const title = running
    ? `${PHASE_NAME[state.phase]}: ${clock(left)} left`
    : paused
      ? `${PHASE_NAME[state.phase]} paused at ${clock(left)}`
      : onBreak
        ? `${PHASE_NAME[state.phase]} ready to start`
        : 'Focus timer'

  return (
    <div className="menu-anchor" ref={ref}>
      {label === null ? (
        <button className={`icon-btn ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} title={title} aria-label="Focus timer" aria-expanded={open} data-testid="focus-timer">
          <Icon name="timer" size={15} />
        </button>
      ) : (
        <button
          className={`focus-pill ${onBreak ? 'break' : ''} ${paused ? 'paused' : ''}`}
          onClick={() => setOpen((o) => !o)}
          title={title}
          aria-label={title}
          aria-expanded={open}
          data-testid="focus-timer"
        >
          <Icon name={paused ? 'pause' : 'timer'} size={13} />
          <span data-testid="focus-pill-time">{label}</span>
        </button>
      )}
      {open && (
        <div className="menu focus-menu" role="dialog" aria-label="Focus timer" data-testid="focus-menu">
          <div className="focus-head">
            <span className="focus-phase" data-testid="focus-phase">
              {PHASE_NAME[state.phase]}
            </span>
            <span className="focus-rounds" aria-label={`${state.done} of ${spec.rounds} focus blocks done this cycle`} title="Focus blocks this cycle">
              {Array.from({ length: spec.rounds }, (_, i) => (
                <i key={i} className={i < state.done ? 'on' : ''} />
              ))}
            </span>
          </div>
          <div className="focus-clock" data-testid="focus-clock">
            {clock(left)}
          </div>
          <div className={`focus-bar ${onBreak ? 'break' : ''}`} aria-hidden="true">
            <i style={{ width: `${done * 100}%` }} />
          </div>
          <div className="focus-actions">
            <button className="btn primary sm" onClick={toggle} data-testid="focus-start">
              <Icon name={running ? 'pause' : 'play'} size={13} /> {running ? 'Pause' : paused ? 'Resume' : onBreak ? 'Start break' : 'Start focus'}
            </button>
            <button className="btn sm" onClick={skip} title={onBreak ? 'End the break' : 'End this block now'} data-testid="focus-skip">
              <Icon name="skip" size={13} /> Skip
            </button>
            <span className="spacer" />
            <button className="icon-btn" onClick={reset} disabled={pristine} title="Reset the timer and the cycle" aria-label="Reset the timer" data-testid="focus-reset">
              <Icon name="refresh" size={14} />
            </button>
          </div>
          <div className="focus-today" data-testid="focus-today">
            Today: {today.blocks} {today.blocks === 1 ? 'block' : 'blocks'} · {today.minutes} min focused
          </div>

          <div className="focus-spec">
            <div className="dlabel">Your rhythm</div>
            <Stepper label="Focus" unit="min" field="focusMinutes" spec={spec} onChange={setSpec} />
            <Stepper label="Short break" unit="min" field="shortBreakMinutes" spec={spec} onChange={setSpec} />
            <Stepper label="Long break" unit="min" field="longBreakMinutes" spec={spec} onChange={setSpec} />
            <Stepper label="Long break after" unit="blocks" field="rounds" spec={spec} onChange={setSpec} />
            <label className="focus-check">
              <input type="checkbox" checked={spec.autoStart} onChange={(e) => void setSpec({ autoStart: e.target.checked })} data-testid="focus-autostart" />
              Start the next block on its own
            </label>
            <label className="focus-check">
              <input type="checkbox" checked={spec.sound} onChange={(e) => void setSpec({ sound: e.target.checked })} data-testid="focus-sound" />
              Chime when a block ends
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

function Stepper({ label, unit, field, spec, onChange }: { label: string; unit: string; field: FocusNumber; spec: FocusSpec; onChange: (patch: Partial<FocusSpec>) => void }): JSX.Element {
  const [min, max] = FOCUS_LIMITS[field]
  const value = spec[field]
  // Blocks and long breaks move in fives, the way people plan them; short breaks by the minute.
  const step = unit === 'min' && field !== 'shortBreakMinutes' ? 5 : 1
  const set = (n: number) => onChange({ [field]: Math.min(max, Math.max(min, n)) })
  return (
    <div className="focus-step" data-testid={`focus-${field}`}>
      <span>{label}</span>
      <span className="spacer" />
      <button className="icon-btn" onClick={() => set(value - step)} disabled={value <= min} aria-label={`Less ${label.toLowerCase()}`}>
        <Icon name="minus" size={12} />
      </button>
      <span className="focus-value" data-testid="focus-value">
        {value} {unit}
      </span>
      <button className="icon-btn" onClick={() => set(value + step)} disabled={value >= max} aria-label={`More ${label.toLowerCase()}`}>
        <Icon name="plus" size={12} />
      </button>
    </div>
  )
}
