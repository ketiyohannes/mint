import { useEffect, useRef, useState, type JSX } from 'react'
import type { Explorable } from '@shared/types'
import { DiagramControls, DiagramFrame } from '../../components/DiagramFrame'
import { api, errorMessage } from '../../lib/api'
import { useApp } from '../../state/app'
import { Icon } from '../../components/Icon'
import { useStudy } from './context'

interface Props {
  explorable: Explorable | null
  highlight: string[]
  params: Record<string, number>
  onParams: (values: Record<string, number>) => void
  onHighlight: (ids: string[]) => void
  onSelect: (e: Explorable | null) => void
}

/** Interactive diagram canvas: sliders, click-to-ask, and the tutor pointing at parts. */
export function DiagramPanel({ explorable, highlight, params, onParams, onHighlight, onSelect }: Props): JSX.Element {
  const { run, toast } = useApp()
  const study = useStudy()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const repairing = useRef<string | null>(null)
  const list = [...study.bundle.explorables].reverse()

  useEffect(() => {
    setStatus(null)
  }, [explorable?.id, explorable?.repairs])

  async function create() {
    if (!prompt.trim()) return
    setBusy(true)
    const out = await run(() => api.diagrams.create(study.classId, prompt.trim()))
    setBusy(false)
    if (out) {
      setPrompt('')
      onSelect(out)
    }
  }

  async function onError(message: string) {
    if (!explorable) return
    setStatus(`The diagram hit an error: ${message}`)
    // Repair automatically (bounded server-side to two attempts per diagram).
    if (repairing.current === `${explorable.id}:${explorable.repairs}` || explorable.repairs >= 2) return
    repairing.current = `${explorable.id}:${explorable.repairs}`
    setStatus('The diagram hit an error. Asking the tutor to fix it…')
    try {
      const fixed = await api.diagrams.repair(study.classId, explorable.id, message)
      onSelect(fixed)
    } catch (err) {
      setStatus(errorMessage(err))
    }
  }

  return (
    <div className="diagram-panel" data-testid="diagram-panel">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <input className="input" placeholder="Describe a diagram, e.g. 'how a matrix stretches a vector'" value={prompt} onChange={(e) => setPrompt(e.target.value)} data-testid="diagram-prompt" />
        <button className="btn primary" disabled={busy || !prompt.trim()} data-testid="diagram-create">
          {busy ? <span className="spinner" /> : <Icon name="sparkle" />} Build
        </button>
      </form>

      {explorable ? (
        <>
          <div className="row">
            <b className="serif" style={{ fontSize: 16, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {explorable.spec.title}
            </b>
            <span className="badge">{explorable.spec.engine}</span>
            <button
              className={`btn ghost sm icon`}
              title={explorable.kept ? 'Kept in your Notebook' : 'Keep in Notebook → Explorables'}
              aria-label="Keep"
              onClick={() => void run(() => api.diagrams.setKept(study.classId, explorable.id, !explorable.kept), explorable.kept ? undefined : 'Saved to Explorables.')}
              style={{ color: explorable.kept ? 'var(--warn)' : undefined }}
              data-testid="diagram-keep"
            >
              <Icon name="star" size={15} />
            </button>
            <button
              className="btn ghost sm icon"
              aria-label="Delete diagram"
              onClick={() => {
                onSelect(null)
                void run(() => api.diagrams.remove(study.classId, explorable.id))
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
          <div className="diagram-stage" ref={stageRef}>
            <DiagramFrame
              spec={explorable.spec}
              highlight={highlight}
              paramValues={params}
              onElementClick={(id, label) => {
                onHighlight([id])
                const rect = stageRef.current?.getBoundingClientRect()
                study.ask({ kind: 'diagram', explorableId: explorable.id, elementId: id, label }, rect ? new DOMRect(rect.left - 400, rect.top + 40, 0, 0) : undefined)
              }}
              onParamChanged={(id, value) => onParams({ ...params, [id]: value })}
              onError={(m) => void onError(m)}
            />
          </div>
          <DiagramControls params={explorable.spec.params} values={params} onChange={(id, value) => onParams({ ...params, [id]: value })} />
          {explorable.spec.caption && <div className="small muted">{explorable.spec.caption}</div>}
          {status && <div className="small" style={{ color: 'var(--warn)' }}>{status}</div>}
          <div className="row wrap small">
            <span className="muted">Parts:</span>
            {explorable.spec.elements.map((el) => (
              <button
                key={el.id}
                className={`chip`}
                style={{ border: 0, cursor: 'pointer', paddingRight: 10, background: highlight.includes(el.id) ? 'var(--primary-soft)' : undefined }}
                title={el.description}
                onClick={() => onHighlight(highlight.includes(el.id) ? [] : [el.id])}
              >
                {el.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="empty small">
          Build a diagram from a prompt, or select a passage in the reader and press <b>Diagram</b>. Click any part of a diagram to ask about it.
        </div>
      )}

      {list.length > 0 && (
        <div>
          <div className="label small" style={{ margin: '8px 0 6px' }}>
            Recent diagrams
          </div>
          <div className="chips">
            {list.slice(0, 12).map((e) => (
              <button
                key={e.id}
                className="chip"
                style={{ border: 0, cursor: 'pointer', paddingRight: 10, fontWeight: e.id === explorable?.id ? 700 : 400 }}
                onClick={() => {
                  onSelect(e)
                  if (!e.spec.code) toast('That diagram has no code.', 'error')
                }}
              >
                {e.kept ? '★ ' : ''}
                {e.spec.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
