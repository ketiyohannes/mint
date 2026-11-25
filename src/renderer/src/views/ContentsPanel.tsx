import { useState, type JSX } from 'react'
import type { ClassBundle } from '@shared/types'
import { useApp } from '../state/app'
import { api } from '../lib/api'
import { Icon } from '../components/Icon'
import { RichText } from '../components/RichText'

interface Props {
  bundle: ClassBundle
  /** Explain an item in its own chat (or open that chat when it was explained before). */
  onExplain: (itemId: string) => void
  openSource: (sourceId: string, section?: string) => void
  onAddMaterials: () => void
  /** Ask for links to add as materials. */
  onAddLinks: () => void
}

/**
 * Simple mode's list: what the materials contain, in reading order. There is
 * no plan and nothing to pass. Pick an item and the tutor explains it; the
 * chips open the passage it comes from.
 */
export function ContentsPanel({ bundle, onExplain, openSource, onAddMaterials, onAddLinks }: Props): JSX.Element {
  const { run, jobs } = useApp()
  const classId = bundle.meta.id
  const contents = bundle.contents
  const [refreshing, setRefreshing] = useState(false)
  const listing = refreshing || jobs.some((j) => j.classId === classId && /^Listing/.test(j.label))
  const importing = jobs.some((j) => j.classId === classId && /^(Reading|Importing)/.test(j.label))
  /** The items that have a chat: those were explained already. */
  const explained = new Set(bundle.threads.map((t) => t.itemId).filter(Boolean))

  async function refresh() {
    setRefreshing(true)
    await run(() => api.contents.refresh(classId))
    setRefreshing(false)
  }

  if (!contents) {
    return (
      <div className="panel-pad stack" data-testid="contents">
        {listing || importing ? (
          <div className="status-line" data-testid="contents-listing">
            <span className="spinner tiny" /> {importing ? 'Reading your material…' : 'Listing what is in your material…'}
          </div>
        ) : !bundle.sources.length ? (
          <div className="stack">
            <p className="muted">Add the paper, book or notes you want to read. mint lists what is in them, and explains whatever you pick.</p>
            <div className="row">
              <button className="btn primary" onClick={onAddMaterials} data-testid="contents-add">
                <Icon name="plus" size={14} /> Add material
              </button>
              <button className="btn" onClick={onAddLinks} data-testid="contents-add-links">
                <Icon name="link" size={14} /> Add links
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <p className="muted">There is no list of this material yet.</p>
            <div>
              <button className="btn primary" onClick={() => void refresh()} data-testid="contents-refresh">
                <Icon name="list" size={14} /> List what is in it
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  const done = contents.items.filter((i) => explained.has(i.id)).length
  return (
    <div className="panel-pad stack plan" data-testid="contents">
      <div className="plan-stats">
        <span>
          <Icon name="list" size={13} /> {contents.items.length} thing{contents.items.length === 1 ? '' : 's'} in here
        </span>
        {done > 0 && <span data-testid="contents-explained">{done} explained</span>}
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => void refresh()} disabled={listing} title="Read the material again and rewrite this list" data-testid="contents-refresh">
          {listing ? <span className="spinner tiny" /> : <Icon name="refresh" size={13} />} Refresh
        </button>
      </div>

      {contents.summary && <RichText text={contents.summary} className="muted small" />}

      <section className="plan-milestone">
        {contents.items.map((item) => {
          const seen = explained.has(item.id)
          return (
            <div key={item.id} className={`plan-topic ${seen ? 'mastered' : 'available'}`} data-testid="contents-item">
              <span className={`status-dot ${seen ? 'mastered' : 'available'}`} title={seen ? 'Explained' : 'Not opened yet'}>
                {seen ? <Icon name="check" size={10} strokeWidth={3} /> : null}
              </span>
              <div className="plan-topic-body">
                <RichText text={item.title} className="plan-topic-title" />
                {item.summary && <RichText text={item.summary} className="small muted" />}
                <div className="plan-topic-meta">
                  {item.sources.map((s, j) => (
                    <button
                      key={j}
                      className="cite-chip"
                      onClick={() => openSource(s.sourceId, s.section)}
                      title={bundle.sources.find((x) => x.id === s.sourceId)?.title}
                      data-testid="contents-source"
                    >
                      ↗ {s.section || 'source'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="plan-topic-action">
                <button className="btn sm" onClick={() => onExplain(item.id)} data-testid="contents-explain">
                  {seen ? 'Open' : 'Explain'}
                </button>
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}
