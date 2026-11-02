/**
 * Hosts one model-generated diagram ("explorable") in the sandbox iframe and
 * bridges it to React: load/param/highlight/resize go in, clicks, hover,
 * errors and sketch-driven param changes come out.
 *
 * Security: the iframe gets `sandbox="allow-scripts"` only (opaque origin, no
 * same-origin access, no popups, forms or top navigation). Messages are
 * accepted only from that iframe's window and only if they pass
 * `isSandboxMessage`; ids/values are re-validated against the spec here.
 */

import { useCallback, useEffect, useId, useMemo, useRef } from 'react'
import type { DiagramParam, DiagramSpec } from '@shared/types'
import { DIAGRAM_SANDBOX_URL, isSandboxMessage, type HostToSandbox, type SandboxToHost } from '@shared/diagramProtocol'
import './diagramFrame.css'

export interface DiagramFrameProps {
  spec: DiagramSpec
  /** Element ids to highlight. */
  highlight: string[]
  /** Parameter values, controlled by the parent. */
  paramValues: Record<string, number>
  onElementClick?: (id: string, label: string) => void
  onHover?: (id: string | null) => void
  onError?: (message: string) => void
  onLoaded?: (registered: string[]) => void
  onParamChanged?: (id: string, value: number) => void
  className?: string
}

function clampToParam(param: DiagramParam, value: number): number {
  return Math.min(param.max, Math.max(param.min, value))
}

export function DiagramFrame(props: DiagramFrameProps): React.JSX.Element {
  const { spec, highlight, paramValues, className } = props
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  /** Values the sandbox currently holds, so only real changes are sent (and echoes are skipped). */
  const sentParamsRef = useRef<Record<string, number>>({})

  // Latest props for the long-lived message listener, without re-subscribing.
  const latest = useRef(props)
  latest.current = props

  // Reload only when the spec's content changes, not merely its object identity.
  const specKey = useMemo(() => JSON.stringify(spec), [spec])
  const specKeyRef = useRef(specKey)
  specKeyRef.current = specKey
  /** specKey of the sketch the sandbox is currently running. */
  const loadedKeyRef = useRef<string | null>(null)
  const highlightKey = highlight.join('\u0000')

  const send = useCallback((message: HostToSandbox) => {
    const target = iframeRef.current?.contentWindow
    // The sandbox origin is opaque ("null"), so '*' is the only usable target origin.
    if (target && readyRef.current) target.postMessage(message, '*')
  }, [])

  const syncParams = useCallback(
    (force: boolean) => {
      const sent = sentParamsRef.current
      for (const param of latest.current.spec.params) {
        const value = latest.current.paramValues[param.id]
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        if (!force && sent[param.id] === value) continue
        sent[param.id] = value
        send({ type: 'param', id: param.id, value })
      }
    },
    [send]
  )

  const loadCurrentSpec = useCallback(() => {
    const current = latest.current
    loadedKeyRef.current = specKeyRef.current
    send({ type: 'load', spec: current.spec })
    sentParamsRef.current = Object.fromEntries(current.spec.params.map((p) => [p.id, p.value]))
    syncParams(false)
    send({ type: 'highlight', ids: current.highlight })
  }, [send, syncParams])

  // Sandbox -> host.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow) return
      if (!isSandboxMessage(event.data)) return
      const message: SandboxToHost = event.data
      const current = latest.current
      switch (message.type) {
        case 'ready':
          // Also fires after the iframe reloads (e.g. renderer crash recovery).
          readyRef.current = true
          loadCurrentSpec()
          break
        case 'loaded':
          current.onLoaded?.(message.registered)
          break
        case 'element-click': {
          // Prefer the label from our own spec over the one the sandbox reports.
          const element = current.spec.elements.find((e) => e.id === message.id)
          current.onElementClick?.(message.id, element?.label ?? message.label)
          break
        }
        case 'hover':
          current.onHover?.(message.id)
          break
        case 'error':
          current.onError?.(message.message)
          break
        case 'param-changed': {
          const param = current.spec.params.find((p) => p.id === message.id)
          if (!param) return
          const value = clampToParam(param, message.value)
          sentParamsRef.current[param.id] = value // the sandbox already has it; do not echo
          current.onParamChanged?.(param.id, value)
          break
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [loadCurrentSpec])

  // Spec content changed -> reload the sketch. Before `ready`, the ready handler loads it.
  useEffect(() => {
    if (readyRef.current && loadedKeyRef.current !== specKey) loadCurrentSpec()
  }, [specKey, loadCurrentSpec])

  useEffect(() => {
    syncParams(false)
  }, [paramValues, syncParams])

  useEffect(() => {
    send({ type: 'highlight', ids: latest.current.highlight })
  }, [highlightKey, send])

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const observer = new ResizeObserver(() => send({ type: 'resize' }))
    observer.observe(iframe)
    return () => observer.disconnect()
  }, [send])

  return (
    <div className={['diagram-frame', className].filter(Boolean).join(' ')}>
      <iframe
        ref={iframeRef}
        className="diagram-frame__iframe"
        src={DIAGRAM_SANDBOX_URL}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={spec.title || 'Interactive diagram'}
      />
    </div>
  )
}

export interface DiagramControlsProps {
  params: DiagramParam[]
  values: Record<string, number>
  onChange: (id: string, value: number) => void
  disabled?: boolean
  className?: string
}

/** Number of decimals implied by a slider step (0.25 -> 2, 5 -> 0). */
function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2
  const text = String(step)
  const exponent = /e-(\d+)$/.exec(text)
  if (exponent) return Number(exponent[1])
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : Math.min(6, text.length - dot - 1)
}

function formatParamValue(param: DiagramParam, value: number): string {
  return value.toFixed(stepDecimals(param.step))
}

/** Labelled range sliders for a diagram's params. */
export function DiagramControls(props: DiagramControlsProps): React.JSX.Element | null {
  const { params, values, onChange, disabled, className } = props
  const baseId = useId()
  if (params.length === 0) return null
  return (
    <div className={['diagram-controls', className].filter(Boolean).join(' ')}>
      {params.map((param) => {
        const inputId = `${baseId}-${param.id}`
        const raw = values[param.id]
        const value = clampToParam(param, typeof raw === 'number' && Number.isFinite(raw) ? raw : param.value)
        const display = formatParamValue(param, value)
        return (
          <div className="diagram-controls__row" key={param.id}>
            <label className="diagram-controls__label" htmlFor={inputId}>
              {param.label}
            </label>
            <input
              id={inputId}
              className="diagram-controls__slider"
              type="range"
              min={param.min}
              max={param.max}
              step={param.step > 0 ? param.step : 'any'}
              value={value}
              disabled={disabled}
              aria-valuetext={display}
              onChange={(event) => onChange(param.id, Number(event.currentTarget.value))}
            />
            <output className="diagram-controls__value" htmlFor={inputId}>
              {display}
            </output>
          </div>
        )
      })}
    </div>
  )
}
