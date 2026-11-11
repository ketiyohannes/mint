import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { PopoutKind, PopoutState, WindowMessage } from '@shared/types'
import { api } from './api'

/**
 * mint's windows. The main window has the chat; the lesson and the panel can
 * each be moved into a window of their own, which runs this same app in
 * another view. The main process knows which windows are open; what one
 * window asks of another (open this source, run this tool) travels as a
 * message that every window receives.
 */
export type WindowView = 'main' | PopoutKind

/** The view this window shows, from its address. */
export const WINDOW_VIEW: WindowView = (() => {
  const view = new URLSearchParams(window.location.search).get('view')
  return view === 'lesson' || view === 'panel' ? view : 'main'
})()

let popouts: PopoutState = { lesson: null, panel: null }
let known = false
let watching = false
const listeners = new Set<() => void>()

function set(next: PopoutState): void {
  popouts = next
  known = true
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!watching) {
    watching = true
    api.on.popouts(set)
    void api.windows
      .state()
      .then(set)
      .catch(() => undefined)
  }
  return () => listeners.delete(listener)
}

/** The class each part's window is showing (null: that part is in the main window). */
export function usePopouts(): PopoutState {
  return useSyncExternalStore(subscribe, () => popouts)
}

/** False until the main process has said which windows are open. */
export function usePopoutsKnown(): boolean {
  return useSyncExternalStore(subscribe, () => known)
}

export function sendToWindows(message: WindowMessage): void {
  void api.windows.send(message).catch(() => undefined)
}

export function focusWindow(target: WindowView): void {
  void api.windows.focus(target).catch(() => undefined)
}

/** Act on messages from the other windows (and this one's own: act only on those for a part this window shows). */
export function useWindowMessages(handler: (message: WindowMessage) => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => api.on.message((m) => latest.current(m)), [])
}

/**
 * A message for the chat that arrived while the main window was elsewhere
 * (Settings, another class): the main window goes to that class, and its
 * workspace picks the message up once it is there.
 */
let held: WindowMessage | null = null

export function holdForClass(message: WindowMessage): void {
  held = message
}

export function takeHeld(classId: string): WindowMessage | null {
  if (!held || held.type === 'settings' || held.classId !== classId) return null
  const message = held
  held = null
  return message
}
