import type { JSX } from 'react'
import { useApp } from '../state/app'
import { hueColor, initials } from '../lib/api'
import { Icon } from './Icon'

export function Sidebar(): JSX.Element {
  const { route, go, classes } = useApp()
  const activeClass = route.name === 'class' ? route.classId : null
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">m</span>
        mint
      </div>
      <button className={`nav-item ${route.name === 'home' ? 'active' : ''}`} onClick={() => go({ name: 'home' })}>
        <Icon name="home" /> Home
      </button>

      <div className="nav-section">
        <span>Classes</span>
        <span>{classes.length || ''}</span>
      </div>
      <nav className="class-list" aria-label="Classes">
        {classes.map((c) => (
          <button
            key={c.id}
            className={`nav-item ${activeClass === c.id ? 'active' : ''}`}
            onClick={() => go({ name: 'class', classId: c.id, tab: c.stage === 'active' ? 'path' : 'path' })}
            title={c.title}
            data-testid="sidebar-class"
          >
            <span className="avatar" style={{ background: hueColor(c.hue) }}>
              {initials(c.title)}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
            {c.reviewsDue > 0 ? (
              <span className="badge amber" title="Reviews due">
                {c.reviewsDue}
              </span>
            ) : c.stage === 'intake' ? (
              <span className="meta">setup</span>
            ) : c.topicsTotal ? (
              <span className="meta">
                {c.topicsMastered}/{c.topicsTotal}
              </span>
            ) : null}
          </button>
        ))}
        {!classes.length && <div className="hint" style={{ padding: '4px 10px' }}>No classes yet.</div>}
      </nav>

      <div className="sidebar-footer">
        <button className={`nav-item ${route.name === 'settings' ? 'active' : ''}`} onClick={() => go({ name: 'settings' })}>
          <Icon name="settings" /> Settings
        </button>
        <button className="btn primary" onClick={() => go({ name: 'new-class' })} data-testid="new-class">
          <Icon name="plus" /> New class
        </button>
      </div>
    </aside>
  )
}
