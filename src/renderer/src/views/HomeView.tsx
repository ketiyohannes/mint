import type { JSX } from 'react'
import { useApp } from '../state/app'
import { hueColor, initials, timeAgo } from '../lib/api'
import { Icon } from '../components/Icon'
import { Activity } from '../components/Activity'

const LEVELS = ['Guided', 'Supported', 'Coached', 'Independent']

function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Good night.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.'
}

export function HomeView(): JSX.Element {
  const { classes, go } = useApp()
  const due = classes.filter((c) => c.reviewsDue > 0)
  return (
    <>
      <div className="topbar">
        <div className="crumbs">
          <b>Home</b>
        </div>
        <div className="spacer" />
        <Activity />
      </div>
      <div className="page">
        <div className="page-inner">
          <div className="hero">
            <span className="brand-mark" style={{ width: 44, height: 44, borderRadius: 12, fontSize: 24 }}>
              m
            </span>
            <h1>{greeting()}</h1>
          </div>

          {!classes.length ? (
            <div className="card empty" style={{ padding: '48px 24px' }}>
              <h3>Start your first class</h3>
              <p style={{ maxWidth: 520, margin: '0 auto 18px' }}>
                Bring your own books, papers, notes or videos, or let mint build a reading list from trusted sources. mint plans a curriculum, sends you to the
                source, and asks you to explain things back, giving less help as you get better.
              </p>
              <button className="btn primary" onClick={() => go({ name: 'new-class' })}>
                <Icon name="plus" /> New class
              </button>
            </div>
          ) : (
            <>
              {due.length > 0 && (
                <div className="banner amber" style={{ marginBottom: 20 }}>
                  <Icon name="clock" />
                  <div style={{ flex: 1 }}>
                    <b>Reviews due.</b> Spaced reviews keep what you learned. {due.map((c) => `${c.title} (${c.reviewsDue})`).join(', ')}
                  </div>
                  <button className="btn sm" onClick={() => go({ name: 'class', classId: due[0].id, tab: 'path' })}>
                    Review now
                  </button>
                </div>
              )}
              <h2 className="section-title" style={{ marginTop: 0 }}>
                Your classes
              </h2>
              <div className="grid-3">
                {classes.map((c) => {
                  const pct = c.topicsTotal ? Math.round((c.topicsMastered / c.topicsTotal) * 100) : 0
                  return (
                    <button key={c.id} className="card class-card" onClick={() => go({ name: 'class', classId: c.id, tab: 'path' })} data-testid="class-card">
                      <div className="row">
                        <span className="avatar" style={{ background: hueColor(c.hue), width: 30, height: 30, borderRadius: 8, fontSize: 13 }}>
                          {initials(c.title)}
                        </span>
                        <span className="spacer" />
                        {c.stage === 'intake' ? <span className="badge amber">Setting up</span> : <span className="badge green">{LEVELS[c.independence.level]}</span>}
                      </div>
                      <h3>{c.title}</h3>
                      {c.stage === 'active' ? (
                        <>
                          <div className="progress-bar">
                            <div style={{ width: `${pct}%` }} />
                          </div>
                          <div className="small muted">
                            {c.topicsMastered} of {c.topicsTotal} topics mastered
                            {c.reviewsDue ? ` · ${c.reviewsDue} review${c.reviewsDue > 1 ? 's' : ''} due` : ''}
                          </div>
                          {c.nextTopic && (
                            <div className="small">
                              <span className="muted">Next up:</span> {c.nextTopic.title}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="small muted">Finish setup: materials, a short diagnostic, then your plan.</div>
                      )}
                      <div className="small muted">Updated {timeAgo(c.updatedAt)}</div>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
