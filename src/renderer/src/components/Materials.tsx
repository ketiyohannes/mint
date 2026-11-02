import { useState, type JSX } from 'react'
import type { ClassBundle, SourceMeta } from '@shared/types'
import { useApp } from '../state/app'
import { api } from '../lib/api'
import { Icon, type IconName } from './Icon'

const KIND_ICON: Record<SourceMeta['kind'], IconName> = {
  pdf: 'file',
  web: 'globe',
  youtube: 'video',
  markdown: 'file',
  text: 'file',
  docx: 'file',
  html: 'globe'
}

/** Add your own files or links. */
export function AddMaterials({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const { run, toast } = useApp()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'files' | 'url' | null>(null)
  const classId = bundle.meta.id

  async function addFiles() {
    setBusy('files')
    const res = await run(() => api.sources.addFiles(classId))
    setBusy(null)
    if (res) {
      if (res.added.length) toast(`Added ${res.added.length} source${res.added.length > 1 ? 's' : ''}.`)
      for (const e of res.errors) toast(e, 'error')
    }
  }

  async function addUrl() {
    if (!url.trim()) return
    setBusy('url')
    const res = await run(() => api.sources.addUrl(classId, url.trim()))
    setBusy(null)
    if (res) {
      toast(`Added "${res.title}".`)
      setUrl('')
    }
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <button className="btn primary" onClick={addFiles} disabled={busy !== null} data-testid="add-files">
          {busy === 'files' ? <span className="spinner" /> : <Icon name="upload" />} Add files
        </button>
        <span className="hint">PDF, Markdown, text, HTML or Word documents.</span>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          void addUrl()
        }}
      >
        <input className="input" placeholder="Paste a link to a page, PDF or YouTube video" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="add-url-input" />
        <button className="btn" disabled={!url.trim() || busy !== null} data-testid="add-url">
          {busy === 'url' ? <span className="spinner" /> : <Icon name="link" />} Add link
        </button>
      </form>
    </div>
  )
}

export function SourceList({ bundle, onOpen, allowRemove }: { bundle: ClassBundle; onOpen?: (s: SourceMeta) => void; allowRemove?: boolean }): JSX.Element {
  const { run } = useApp()
  if (!bundle.sources.length) return <div className="hint">No sources yet.</div>
  return (
    <div className="stack" style={{ gap: 8 }}>
      {bundle.sources.map((s) => (
        <div key={s.id} className="list-item" style={{ cursor: onOpen ? 'pointer' : 'default' }} onClick={() => onOpen?.(s)} data-testid="source-item">
          <Icon name={KIND_ICON[s.kind]} size={18} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</div>
            <div className="small muted">
              {s.kind.toUpperCase()} · {s.sectionCount} section{s.sectionCount === 1 ? '' : 's'} · {s.wordCount.toLocaleString()} words
              {s.domain ? ` · ${s.domain}` : ''}
            </div>
            {s.why && <div className="small muted">{s.why}</div>}
            {s.needsTranscript && <div className="small" style={{ color: 'var(--warn)' }}>No transcript yet. Open it to paste one.</div>}
          </div>
          <span className={`badge ${s.origin === 'user' ? 'blue' : 'green'}`}>{s.origin === 'user' ? 'Yours' : 'Found by mint'}</span>
          {allowRemove && (
            <button
              className="btn ghost sm icon"
              aria-label={`Remove ${s.title}`}
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(`Remove "${s.title}" from this class?`)) void run(() => api.sources.remove(bundle.meta.id, s.id), 'Source removed.')
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** Trusted-source fallback: mint proposes, the learner approves each source. */
export function TrustedSources({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const { run } = useApp()
  const [focus, setFocus] = useState('')
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const classId = bundle.meta.id
  const open = bundle.sourceProposals.filter((p) => p.status === 'proposed' || p.status === 'failed' || p.status === 'approved')
  const importing = bundle.sourceProposals.some((p) => p.status === 'approved')

  async function find() {
    setBusy(true)
    await run(() => api.sources.proposeTrusted(classId, focus.trim() || undefined))
    setBusy(false)
  }

  async function resolve(approve: string[], reject: string[]) {
    setPicked(new Set())
    await run(() => api.sources.resolveProposals(classId, approve, reject))
  }

  const proposedIds = open.filter((p) => p.status !== 'approved').map((p) => p.id)

  return (
    <div className="stack">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          void find()
        }}
      >
        <input className="input" placeholder="Optional focus, e.g. 'intuition for eigenvectors' or 'a lecture series'" value={focus} onChange={(e) => setFocus(e.target.value)} />
        <button className="btn primary" disabled={busy} data-testid="find-trusted">
          {busy ? <span className="spinner" /> : <Icon name="sparkle" />} Find trusted sources
        </button>
      </form>
      <div className="hint">
        Searches only {bundle.meta.trustedDomains.length} trusted domains (plus YouTube). Every source needs your approval before mint teaches from it.
      </div>
      {open.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          {open.map((p) => (
            <label key={p.id} className="list-item" style={{ cursor: p.status === 'approved' ? 'default' : 'pointer' }} data-testid="proposal">
              {p.status === 'approved' ? (
                <span className="spinner" style={{ marginTop: 3 }} />
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
                  style={{ marginTop: 4 }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row">
                  <Icon name={p.kind === 'youtube' ? 'video' : 'globe'} size={14} />
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</b>
                </div>
                <div className="small muted" style={{ wordBreak: 'break-all' }}>
                  {p.url}
                </div>
                <div className="small">
                  <b>Why trust it:</b> {p.why}
                </div>
                <div className="small">
                  <b>Covers:</b> {p.covers}
                </div>
                {p.newDomain && <div className="small" style={{ color: 'var(--warn)' }}>⚠ {p.domain} is not on your trusted list. Approving adds it.</div>}
                {p.status === 'failed' && <div className="small" style={{ color: 'var(--danger)' }}>Import failed: {p.error}</div>}
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
            </label>
          ))}
          <div className="row">
            <button className="btn primary" disabled={!picked.size || importing} onClick={() => resolve([...picked], [])} data-testid="approve-proposals">
              <Icon name="check" /> Approve and import {picked.size || ''}
            </button>
            <button className="btn" disabled={!proposedIds.length || importing} onClick={() => resolve([], proposedIds.filter((id) => !picked.has(id)))}>
              Reject unselected
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function TrustedDomains({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const { run } = useApp()
  const [value, setValue] = useState('')
  const domains = bundle.meta.trustedDomains
  const save = (next: string[]) => run(() => api.classes.update(bundle.meta.id, { trustedDomains: next }))
  return (
    <div className="stack">
      <div className="chips">
        {domains.map((d) => (
          <span key={d} className="chip">
            {d}
            <button aria-label={`Remove ${d}`} onClick={() => void save(domains.filter((x) => x !== d))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) void save([...domains, value.trim()]).then(() => setValue(''))
        }}
      >
        <input className="input" placeholder="Add a trusted domain, e.g. ocw.mit.edu" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn" disabled={!value.trim()}>
          Add
        </button>
      </form>
    </div>
  )
}
