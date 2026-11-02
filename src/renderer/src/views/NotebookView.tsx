import { useEffect, useState, type JSX } from 'react'
import type { Anchor, ClassBundle, Explorable, NoteDoc } from '@shared/types'
import { allTopics } from '@shared/curriculum'
import { useApp } from '../state/app'
import { api, errorMessage, newStreamId, timeAgo } from '../lib/api'
import { Icon } from '../components/Icon'
import { Markdown } from '../components/Markdown'
import { DiagramControls, DiagramFrame } from '../components/DiagramFrame'

type Tab = 'notes' | 'stickies' | 'glossary' | 'reference' | 'explorables'

export function NotebookView({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const [tab, setTab] = useState<Tab>('notes')
  const pinned = bundle.threads.filter((t) => t.pinned).length + bundle.annotations.filter((a) => a.kind === 'note').length
  const tabs: [Tab, string][] = [
    ['notes', 'Notes'],
    ['stickies', `Stickies ${pinned || ''}`],
    ['glossary', `Glossary ${bundle.glossary.length || ''}`],
    ['reference', 'Reference sheets'],
    ['explorables', `Explorables ${bundle.explorables.filter((e) => e.kept).length || ''}`]
  ]
  return (
    <div className="page">
      <div className="page-inner">
        <div className="tabs" style={{ display: 'inline-flex', marginBottom: 20 }}>
          {tabs.map(([id, label]) => (
            <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)} data-testid={`nb-${id}`}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'notes' && <Notes bundle={bundle} kind="note" />}
        {tab === 'reference' && <Notes bundle={bundle} kind="reference" />}
        {tab === 'stickies' && <Stickies bundle={bundle} />}
        {tab === 'glossary' && <Glossary bundle={bundle} />}
        {tab === 'explorables' && <Explorables bundle={bundle} />}
      </div>
    </div>
  )
}

function Notes({ bundle, kind }: { bundle: ClassBundle; kind: NoteDoc['kind'] }): JSX.Element {
  const { run, toast } = useApp()
  const notes = bundle.notes.filter((n) => n.kind === kind).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const [activeId, setActiveId] = useState<string | null>(notes[0]?.id ?? null)
  const active = notes.find((n) => n.id === activeId) ?? null
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState(false)
  const [review, setReview] = useState<{ text: string; busy: boolean } | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [topicId, setTopicId] = useState('')
  const topics = allTopics(bundle.curriculum)
  const canDraft = kind === 'reference' && bundle.independence.level < 2

  useEffect(() => {
    setTitle(active?.title ?? '')
    setBody(active?.body ?? '')
    setReview(null)
  }, [active?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = active ? title !== active.title || body !== active.body : title.trim() !== '' || body.trim() !== ''

  async function save() {
    const saved = await run(() => api.notes.save(bundle.meta.id, { id: active?.id, kind, title: title || 'Untitled', body }), 'Saved.')
    if (saved) setActiveId(saved.id)
  }

  async function askReview() {
    if (!active) return
    if (dirty) await save()
    const streamId = newStreamId()
    setReview({ text: '', busy: true })
    const off = api.on.stream((e) => {
      if (e.streamId === streamId && e.delta) setReview((r) => (r ? { ...r, text: r.text + e.delta } : r))
    })
    try {
      const text = await api.notes.review(bundle.meta.id, active.id, streamId)
      setReview({ text, busy: false })
    } catch (err) {
      toast(errorMessage(err), 'error')
      setReview(null)
    } finally {
      off()
    }
  }

  return (
    <div className="note-editor">
      <div className="stack" style={{ gap: 6 }}>
        <button
          className="btn primary"
          onClick={() => {
            setActiveId(null)
            setTitle('')
            setBody('')
          }}
          data-testid="new-note"
        >
          <Icon name="plus" /> New {kind === 'reference' ? 'sheet' : 'note'}
        </button>
        {kind === 'reference' && (
          <div className="card soft small" style={{ padding: 10 }}>
            {canDraft ? (
              <>
                <select className="select" value={topicId} onChange={(e) => setTopicId(e.target.value)} style={{ marginBottom: 6 }}>
                  <option value="">Whole class</option>
                  {topics.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
                <button
                  className="btn sm"
                  style={{ width: '100%' }}
                  disabled={drafting}
                  onClick={async () => {
                    setDrafting(true)
                    const n = await run(() => api.notes.draftReference(bundle.meta.id, topicId || null), 'Draft ready. Rewrite it in your own words.')
                    setDrafting(false)
                    if (n) setActiveId(n.id)
                  }}
                  data-testid="draft-reference"
                >
                  {drafting ? <span className="spinner" /> : <Icon name="sparkle" size={13} />} Draft with tutor
                </button>
                <div className="muted" style={{ marginTop: 6 }}>
                  At higher independence you will write these yourself.
                </div>
              </>
            ) : (
              <span className="muted">You are at an independence level where you write reference sheets yourself. Ask the tutor to review them.</span>
            )}
          </div>
        )}
        {notes.map((n) => (
          <button key={n.id} className={`nav-item ${n.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(n.id)}>
            <div style={{ minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</div>
              <div className="small muted">
                {n.authoredBy === 'tutor-draft' ? 'Tutor draft · ' : ''}
                {timeAgo(n.updatedAt)}
              </div>
            </div>
          </button>
        ))}
        {!notes.length && <div className="hint">Nothing yet.</div>}
      </div>
      <div className="stack">
        <div className="row">
          <input className="input serif" style={{ fontSize: 20, fontWeight: 600 }} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="note-title" />
          <div className="tabs">
            <button className={`tab ${!preview ? 'active' : ''}`} onClick={() => setPreview(false)}>
              Write
            </button>
            <button className={`tab ${preview ? 'active' : ''}`} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
        </div>
        {active?.authoredBy === 'tutor-draft' && <div className="banner amber small">Tutor draft. Rewrite it in your own words: compressing an idea yourself is part of learning it.</div>}
        {preview ? (
          <div className="card" style={{ minHeight: 360 }}>
            <Markdown text={body || '_Nothing to preview._'} />
          </div>
        ) : (
          <textarea className="textarea" placeholder="Write in your own words. Markdown and $math$ work." value={body} onChange={(e) => setBody(e.target.value)} data-testid="note-body" />
        )}
        <div className="row">
          <button className="btn primary" disabled={!dirty} onClick={save} data-testid="note-save-btn">
            <Icon name="check" /> Save
          </button>
          {active && (
            <button className="btn" disabled={review?.busy} onClick={askReview} data-testid="note-review">
              {review?.busy ? <span className="spinner" /> : <Icon name="sparkle" size={14} />} Ask the tutor to review
            </button>
          )}
          <span className="spacer" />
          {active && (
            <button
              className="btn ghost danger"
              onClick={() => {
                if (window.confirm('Delete this note?')) {
                  void run(() => api.notes.remove(bundle.meta.id, active.id))
                  setActiveId(null)
                }
              }}
            >
              <Icon name="trash" size={14} /> Delete
            </button>
          )}
        </div>
        {review && (
          <div className="card soft">
            <div className="card-title">
              <Icon name="sparkle" size={14} /> Tutor review
            </div>
            <Markdown text={review.text || '…'} streaming={review.busy} />
          </div>
        )}
      </div>
    </div>
  )
}

function Stickies({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const { run, focusSource } = useApp()
  const threads = [...bundle.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const notes = bundle.annotations.filter((a) => a.kind === 'note')
  const title = (id: string) => bundle.sources.find((s) => s.id === id)?.title ?? 'source'
  if (!threads.length && !notes.length) return <div className="card empty">Ask threads and sticky notes you make while reading collect here.</div>
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="label">Ask threads</div>
        {threads.map((t) => (
          <div key={t.id} className="card" style={{ padding: 14 }} data-testid="nb-thread">
            <div className="row">
              <span className="pin q">?</span>
              <b style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</b>
              {!t.pinned && <span className="badge">unpinned</span>}
            </div>
            <div className="small muted" style={{ margin: '4px 0 8px' }}>
              {t.anchor.kind === 'source' ? `${title(t.anchor.sourceId)} · ${t.anchor.sectionLabel}` : t.anchor.kind} · {t.messages.length} messages · {timeAgo(t.updatedAt)}
            </div>
            <div className="row wrap">
              {t.anchor.kind === 'source' && (
                <button className="btn sm" onClick={() => focusSource(bundle.meta.id, { sourceId: (t.anchor as Extract<Anchor, { kind: 'source' }>).sourceId, section: (t.anchor as Extract<Anchor, { kind: 'source' }>).sectionLabel, quote: (t.anchor as Extract<Anchor, { kind: 'source' }>).quote })}>
                  Open in reader
                </button>
              )}
              <button className="btn sm" onClick={() => void run(() => api.notes.fromThread(bundle.meta.id, t.id), 'Copied to Notes. Add your own summary.')}>
                Turn into a note
              </button>
              <button className="btn ghost sm" onClick={() => void run(() => api.threads.setPinned(bundle.meta.id, t.id, !t.pinned))}>
                {t.pinned ? 'Unpin' : 'Pin'}
              </button>
              <button className="btn ghost sm icon" aria-label="Delete thread" onClick={() => window.confirm('Delete this thread?') && void run(() => api.threads.remove(bundle.meta.id, t.id))}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <div className="label">Sticky notes</div>
        {notes.map((n) => (
          <div key={n.id} className="card" style={{ padding: 14, borderLeft: '3px solid var(--note-color)' }}>
            <div>{n.text || <span className="muted">(empty)</span>}</div>
            <div className="small muted" style={{ margin: '4px 0 8px' }}>
              “{n.anchor.quote.slice(0, 160)}” · {title(n.anchor.sourceId)}
            </div>
            <button className="btn sm" onClick={() => focusSource(bundle.meta.id, { sourceId: n.anchor.sourceId, section: n.anchor.sectionLabel, quote: n.anchor.quote })}>
              Open in reader
            </button>
          </div>
        ))}
        {!notes.length && <div className="hint">Select text in the reader and press Note.</div>}
      </div>
    </div>
  )
}

function Glossary({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const { run, toast } = useApp()
  const [term, setTerm] = useState('')
  const [def, setDef] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const terms = [...bundle.glossary].sort((a, b) => a.term.localeCompare(b.term))
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card" style={{ padding: '4px 20px' }}>
        {!terms.length && <div className="empty small">Your glossary is earned: terms are added once you can use them correctly.</div>}
        {terms.map((t) => (
          <div key={t.id} className="term" data-testid="glossary-term">
            <div className="row">
              <b>{t.term}</b>
              <span className="spacer" />
              <button className="btn ghost sm icon" aria-label={`Remove ${t.term}`} onClick={() => window.confirm(`Remove "${t.term}"?`) && void run(() => api.glossary.remove(bundle.meta.id, t.id))}>
                <Icon name="trash" size={13} />
              </button>
            </div>
            <div>{t.definition}</div>
            {t.avoid.length > 0 && (
              <div className="small muted">
                <i>Avoid:</i> {t.avoid.join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-title">Add a term you understand</div>
        <div className="field">
          <label htmlFor="g-term">Term</label>
          <input id="g-term" className="input" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="g-def">Your definition (what it is, in your words)</label>
          <textarea id="g-def" className="textarea" value={def} onChange={(e) => setDef(e.target.value)} />
        </div>
        {feedback && <div className={`verdict ${feedback.ok ? 'pass' : 'partial'} small`} style={{ marginBottom: 10 }}>{feedback.text}</div>}
        <button
          className="btn primary"
          disabled={busy || !term.trim() || !def.trim()}
          onClick={async () => {
            setBusy(true)
            try {
              const res = await api.glossary.propose(bundle.meta.id, term, def)
              setFeedback({ ok: res.accepted, text: res.feedback })
              if (res.accepted) {
                setTerm('')
                setDef('')
              }
            } catch (err) {
              toast(errorMessage(err), 'error')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? <span className="spinner" /> : null} Check and add
        </button>
      </div>
    </div>
  )
}

function Explorables({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const { run } = useApp()
  const kept = bundle.explorables.filter((e) => e.kept)
  const [open, setOpen] = useState<Explorable | null>(null)
  const [params, setParams] = useState<Record<string, number>>({})
  if (!kept.length) return <div className="card empty">Diagrams you keep (★) while studying are saved here.</div>
  return (
    <>
      <div className="grid-3">
        {kept.map((e) => (
          <button
            key={e.id}
            className="card class-card"
            onClick={() => {
              setOpen(e)
              setParams(Object.fromEntries(e.spec.params.map((p) => [p.id, p.value])))
            }}
          >
            <span className="badge">{e.spec.engine}</span>
            <h3 style={{ fontSize: 17 }}>{e.spec.title}</h3>
            <div className="small muted">{e.spec.caption}</div>
          </button>
        ))}
      </div>
      {open && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <b className="serif" style={{ fontSize: 18, flex: 1 }}>
              {open.spec.title}
            </b>
            <button className="btn ghost sm" onClick={() => void run(() => api.diagrams.setKept(bundle.meta.id, open.id, false)).then(() => setOpen(null))}>
              Remove from Explorables
            </button>
            <button className="btn ghost sm icon" aria-label="Close" onClick={() => setOpen(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="diagram-stage" style={{ height: 420 }}>
            <DiagramFrame spec={open.spec} highlight={[]} paramValues={params} onParamChanged={(id, v) => setParams((p) => ({ ...p, [id]: v }))} />
          </div>
          <DiagramControls params={open.spec.params} values={params} onChange={(id, v) => setParams((p) => ({ ...p, [id]: v }))} />
          <p className="small muted">Open the Study tab to ask about parts of this diagram.</p>
        </div>
      )}
    </>
  )
}
