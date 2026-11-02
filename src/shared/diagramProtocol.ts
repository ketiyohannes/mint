/**
 * postMessage protocol between the renderer (host) and the diagram sandbox
 * iframe served at `mint-sandbox://app/index.html`.
 *
 * The sandbox runs untrusted, model-generated sketch code in an opaque origin,
 * so every message coming OUT of it is treated as hostile input: the host only
 * accepts messages from the iframe's own window that pass `isSandboxMessage`.
 *
 * The sandbox side (`resources/diagram-sandbox/runtime.js`) is plain JS and
 * must follow these shapes by hand.
 */

import type { DiagramSpec } from './types'

/** Scheme registered by the main process for the sandbox page and its assets. */
export const DIAGRAM_SANDBOX_SCHEME = 'mint-sandbox'
/** Host part of every sandbox URL. */
export const DIAGRAM_SANDBOX_HOST = 'app'
/** Entry page the host iframe points at. */
export const DIAGRAM_SANDBOX_URL = `${DIAGRAM_SANDBOX_SCHEME}://${DIAGRAM_SANDBOX_HOST}/index.html`

/**
 * Content Security Policy for the sandbox page. Sent as a response header by the
 * protocol handler AND declared in a <meta> tag in index.html (a unit test keeps
 * the two identical). `connect-src 'none'` + `default-src 'none'` mean the page
 * cannot fetch, open sockets, load fonts, frames or workers.
 */
export const DIAGRAM_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline' mint-sandbox:",
  "style-src 'self' 'unsafe-inline'",
  'img-src data: blob:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

// ---------------------------------------------------------------------------
// Host -> sandbox
// ---------------------------------------------------------------------------

export interface LoadMessage {
  type: 'load'
  spec: DiagramSpec
}

export interface ParamMessage {
  type: 'param'
  id: string
  value: number
}

export interface HighlightMessage {
  type: 'highlight'
  /** Element ids to emphasise. An empty array clears the highlight. */
  ids: string[]
}

export interface ResizeMessage {
  type: 'resize'
}

export type HostToSandbox = LoadMessage | ParamMessage | HighlightMessage | ResizeMessage

// ---------------------------------------------------------------------------
// Sandbox -> host
// ---------------------------------------------------------------------------

/** Runtime booted and is listening; the host should (re)send `load`. */
export interface ReadyMessage {
  type: 'ready'
}

/** The sketch started. `registered` lists the element ids it has registered so far. */
export interface LoadedMessage {
  type: 'loaded'
  registered: string[]
}

export interface ElementClickMessage {
  type: 'element-click'
  id: string
  label: string
}

export interface HoverMessage {
  type: 'hover'
  id: string | null
}

export interface ErrorMessage {
  type: 'error'
  message: string
  stack?: string
}

/** Sketch code changed a parameter itself via `mint.setParam`. */
export interface ParamChangedMessage {
  type: 'param-changed'
  id: string
  value: number
}

export type SandboxToHost =
  | ReadyMessage
  | LoadedMessage
  | ElementClickMessage
  | HoverMessage
  | ErrorMessage
  | ParamChangedMessage

// ---------------------------------------------------------------------------
// Runtime guard
// ---------------------------------------------------------------------------

/** Upper bounds keep a hostile sketch from pushing megabytes through the host. */
export const SANDBOX_LIMITS = {
  id: 200,
  label: 500,
  message: 4_000,
  stack: 16_000,
  registered: 500
} as const

function isShortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function isElementId(value: unknown): value is string {
  return isShortString(value, SANDBOX_LIMITS.id) && value.length > 0
}

/**
 * Validates a message received from the sandbox iframe. Rejects unknown types,
 * wrong field types, non-finite numbers and oversized payloads.
 */
export function isSandboxMessage(x: unknown): x is SandboxToHost {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const m = x as Record<string, unknown>
  switch (m.type) {
    case 'ready':
      return true
    case 'loaded':
      return (
        Array.isArray(m.registered) &&
        m.registered.length <= SANDBOX_LIMITS.registered &&
        m.registered.every(isElementId)
      )
    case 'element-click':
      return isElementId(m.id) && isShortString(m.label, SANDBOX_LIMITS.label)
    case 'hover':
      return m.id === null || isElementId(m.id)
    case 'error':
      return (
        isShortString(m.message, SANDBOX_LIMITS.message) &&
        (m.stack === undefined || isShortString(m.stack, SANDBOX_LIMITS.stack))
      )
    case 'param-changed':
      return isElementId(m.id) && typeof m.value === 'number' && Number.isFinite(m.value)
    default:
      return false
  }
}
