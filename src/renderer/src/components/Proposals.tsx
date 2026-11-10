import { useState, type JSX } from 'react'
import type { ClassBundle } from '@shared/types'
import { useApp } from '../state/app'
import { api } from '../lib/api'
import { Icon } from './Icon'
import { RichText } from './RichText'

/**
 * Trusted-source fallback: mint proposes sources from allowlisted sites and
 * YouTube; the learner approves each one. `compact` renders nothing unless
 * suggestions are waiting.
 */
export function Proposals({ bundle, compact }: { bundle: ClassBundle; compact?: boolean }): JSX.Element | null {
  const { run, jobs } = useApp()
  const [focus, setFocus] = useState('')
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const classId = bundle.meta.id
  const open = bundle.sourceProposals.filter((p) => p.status === 'proposed' || p.status === 'failed' || p.status === 'approved')
  const importing = open.some((p) => p.status === 'approved')
  const searching = busy || jobs.some((j) => j.classId === classId && /trusted sources/i.test(j.label))
  if (compact && !open.length) return null

  async function find() {
    setBusy(true)
    await run(() => api.sources.proposeTrusted(classId, focus.trim() || undefined))
    setBusy(false)
  }

  async function resolve(approve: string[], reject: string[]) {
    setPicked(new Set())
    await run(() => api.sources.resolveProposals(classId, approve, reject))
  }

  const waiting = open.filter((p) => p.status !== 'approved').map((p) => p.id)
  const sites = bundle.meta.trustedDomains.length

  return (
    <div className="proposals stack" data-testid="proposals">
      <div className="proposals-title">
        <Icon name="shield" size={14} /> {open.length ? 'Suggested sources' : 'Find trusted sources'}
      </div>
      {!open.length && (
        <>
          <p className="small muted">
            mint searches only {sites} trusted {sites === 1 ? 'site' : 'sites'} plus YouTube, says why each source is trustworthy, and imports nothing without your approval.
          </p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              void find()
            }}
          >
            <input className="input sm" placeholder={`Focus (optional), e.g. intuition for ${bundle.meta.mission.topic || 'the basics'}`} value={focus} onChange={(e) => setFocus(e.target.value)} />
            <button className="btn sm primary" disabled={searching} data-testid="find-trusted">
              {searching ? <span className="spinner tiny" /> : <Icon name="sparkle" size={13} />} {searching ? 'Searching…' : 'Find'}
            </button>
          </form>
        </>
      )}
      {open.map((p) => {
        // A row being imported has no checkbox: as a label it would press its Preview button on any click.
        const Row = p.status === 'approved' ? 'div' : 'label'
        return (
          <Row key={p.id} className={`proposal ${p.status === 'approved' ? 'importing' : ''}`} data-testid="proposal">
            {p.status === 'approved' ? (
              <span className="spinner tiny" />
            ) : (
              <input
                type="checkbox"
                checked={picked.has(p.id)}
                onChange={(e) =>
                  setPicked((s) => {
                    const next = new Set(s)
                    if (e.target.checked) next.add(p.id)
                    else next.delete(p.id)
                    return next
                  })
                }
              />
            )}
            <div className="proposal-body">
              <div className="row">
                <Icon name={p.kind === 'youtube' ? 'video' : 'globe'} size={13} />
                <b className="ellipsis">
                  <RichText text={p.title} inline />
                </b>
              </div>
              <div className="small muted ellipsis">{p.url}</div>
              <RichText text={p.why} className="small" />
              <RichText text={`Covers: ${p.covers}`} className="small muted" />
              {p.newDomain && <div className="small warn">{p.domain} is not on your trusted list. Approving adds it.</div>}
              {p.status === 'failed' && <div className="small danger">Import failed: {p.error}</div>}
            </div>
            <button
              type="button"
              className="btn ghost sm"
              onClick={(e) => {
                e.preventDefault()
                void api.system.openExternal(p.url)
              }}
            >
              Preview
            </button>
          </Row>
        )
      })}
      {open.length > 0 && (
        <div className="row">
          <button className="btn sm primary" disabled={!picked.size || importing} onClick={() => void resolve([...picked], [])} data-testid="approve-proposals">
            <Icon name="check" size={13} /> Import {picked.size || ''}
          </button>
          <button
            className="btn sm ghost"
            disabled={!waiting.length || importing}
            onClick={() =>
              void resolve(
                [],
                waiting.filter((id) => !picked.has(id))
              )
            }
          >
            Dismiss the rest
          </button>
        </div>
      )}
    </div>
  )
}
