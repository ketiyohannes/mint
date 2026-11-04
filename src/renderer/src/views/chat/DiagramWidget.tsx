import { useEffect, useRef, useState, type JSX } from 'react'
import type { Explorable } from '@shared/types'
import { DiagramControls, DiagramFrame } from '../../components/DiagramFrame'
import { Icon } from '../../components/Icon'
import { RichText } from '../../components/RichText'
import { api, errorMessage } from '../../lib/api'
import { useStudy } from '../study/context'

/** An interactive p5/three diagram in the chat: sliders, click a part to ask, the tutor points at parts. */
export function DiagramWidget({ explorable }: { explorable: Explorable | undefined }): JSX.Element {
  const study = useStudy()
  const [highlight, setHighlight] = useState<string[]>([])
  const [params, setParams] = useState<Record<string, number>>({})
  const [status, setStatus] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const repairing = useRef<string | null>(null)
  const key = explorable ? `${explorable.id}:${explorable.repairs}` : ''

  useEffect(() => {
    if (!explorable) return
    setParams(Object.fromEntries(explorable.spec.params.map((p) => [p.id, p.value])))
    setHighlight([])
    setStatus(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Let tutor directives point at this diagram's parts and move its sliders.
  const { registerDiagram } = study
  useEffect(() => {
    if (!explorable) return
    registerDiagram(explorable.id, {
      highlight: (id) => setHighlight([id]),
      set: (id, value) => {
        const p = explorable.spec.params.find((x) => x.id === id)
        if (p) setParams((v) => ({ ...v, [id]: Math.min(p.max, Math.max(p.min, value)) }))
      }
    })
    return () => registerDiagram(explorable.id, null)
  }, [explorable, registerDiagram])

  if (!explorable) return <div className="widget muted small">This diagram was deleted.</div>

  async function onError(message: string) {
    if (!explorable) return
    setStatus(`The diagram hit an error: ${message}`)
    // Repair automatically (bounded server-side to two attempts per diagram).
    if (repairing.current === key || explorable.repairs >= 2) return
    repairing.current = key
    setStatus('The diagram hit an error. Asking the tutor to fix it…')
    try {
      await api.diagrams.repair(study.classId, explorable.id, message)
    } catch (err) {
      setStatus(errorMessage(err))
    }
  }

  return (
    <div className="widget diagram" data-testid="diagram-widget">
      <div className="widget-head">
        <Icon name="diagram" size={14} /> <b className="ellipsis">{explorable.spec.title}</b>
        <span className="badge">{explorable.spec.engine}</span>
      </div>
      <div className="diagram-stage" ref={stageRef}>
        <DiagramFrame
          spec={explorable.spec}
          highlight={highlight}
          paramValues={params}
          onElementClick={(id, label) => {
            setHighlight([id])
            const rect = stageRef.current?.getBoundingClientRect()
            study.ask({ kind: 'diagram', explorableId: explorable.id, elementId: id, label }, rect ? new DOMRect(rect.right, rect.top + 40, 0, 0) : undefined)
          }}
          onParamChanged={(id, value) => setParams((v) => ({ ...v, [id]: value }))}
          onError={(m) => void onError(m)}
        />
      </div>
      <DiagramControls params={explorable.spec.params} values={params} onChange={(id, value) => setParams((v) => ({ ...v, [id]: value }))} />
      {explorable.spec.caption && <RichText text={explorable.spec.caption} className="small muted" />}
      {status && <div className="small warn">{status}</div>}
      <div className="row wrap small">
        <span className="muted">Parts (click to ask):</span>
        {explorable.spec.elements.map((el) => (
          <button
            key={el.id}
            className={`chip ${highlight.includes(el.id) ? 'on' : ''}`}
            title={el.description}
            onClick={(e) => {
              setHighlight([el.id])
              study.ask({ kind: 'diagram', explorableId: explorable.id, elementId: el.id, label: el.label }, e.currentTarget.getBoundingClientRect())
            }}
          >
            {el.label}
          </button>
        ))}
      </div>
    </div>
  )
}
