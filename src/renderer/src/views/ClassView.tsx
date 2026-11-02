import { useState, type JSX } from 'react'
import type { ClassBundle } from '@shared/types'
import { useApp, type ClassTab } from '../state/app'
import { useClassBundle } from '../state/useClass'
import { Icon, type IconName } from '../components/Icon'
import { Activity } from '../components/Activity'
import { SetupView } from './SetupView'
import { PathView } from './PathView'
import { StudyView } from './study/StudyView'
import { LibraryView } from './LibraryView'
import { NotebookView } from './NotebookView'
import { ProgressView } from './ProgressView'
import { api } from '../lib/api'

const TABS: { id: ClassTab; label: string; icon: IconName }[] = [
  { id: 'path', label: 'Path', icon: 'path' },
  { id: 'study', label: 'Study', icon: 'book' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'notebook', label: 'Notebook', icon: 'notebook' },
  { id: 'progress', label: 'Progress', icon: 'chart' }
]

const LEVELS = ['Guided', 'Supported', 'Coached', 'Independent']

export function ClassView({ classId, tab }: { classId: string; tab: ClassTab }): JSX.Element {
  const { go, run } = useApp()
  const { bundle, error } = useClassBundle(classId)

  if (error) {
    return (
      <div className="page">
        <div className="page-inner empty">
          <h3>Could not open this class</h3>
          <p>{error}</p>
          <button className="btn" onClick={() => go({ name: 'home' })}>
            Back home
          </button>
        </div>
      </div>
    )
  }
  if (!bundle) {
    return (
      <div className="page">
        <div className="page-inner empty">
          <span className="spinner" />
        </div>
      </div>
    )
  }

  const setup = bundle.meta.stage === 'intake'
  return (
    <>
      <div className="topbar">
        <div className="crumbs">
          <span>Classes</span>/<b>{bundle.meta.title}</b>
        </div>
        <div className="spacer" />
        <Activity classId={classId} />
        {!setup && (
          <span className="badge green" title={bundle.independence.reason} data-testid="independence-badge">
            <Icon name="target" size={12} /> {LEVELS[bundle.independence.level]}
          </span>
        )}
        <ClassMenu
          onDelete={async () => {
            if (!window.confirm(`Delete "${bundle.meta.title}" and everything in it? This cannot be undone.`)) return
            await run(() => api.classes.remove(classId), 'Class deleted.')
            go({ name: 'home' })
          }}
        />
      </div>
      {tab !== 'study' || setup ? <ClassHeader bundle={bundle} tab={setup ? null : tab} onTab={(t) => go({ name: 'class', classId, tab: t })} /> : null}
      {setup ? (
        <SetupView bundle={bundle} />
      ) : tab === 'path' ? (
        <PathView bundle={bundle} />
      ) : tab === 'study' ? (
        <StudyView bundle={bundle} onTab={(t) => go({ name: 'class', classId, tab: t })} />
      ) : tab === 'library' ? (
        <LibraryView bundle={bundle} />
      ) : tab === 'notebook' ? (
        <NotebookView bundle={bundle} />
      ) : (
        <ProgressView bundle={bundle} />
      )}
    </>
  )
}

function ClassHeader({ bundle, tab, onTab }: { bundle: ClassBundle; tab: ClassTab | null; onTab: (t: ClassTab) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const m = bundle.meta.mission
  return (
    <div className="class-header">
      <h1>{bundle.meta.title}</h1>
      <div className="mission-card" data-testid="mission-card">
        <Icon name="target" size={15} />
        <div style={{ flex: 1 }}>
          <b>Mission:</b> {m.why || 'Not stated yet.'}
          {open && (
            <div style={{ marginTop: 6 }}>
              {m.successLooksLike.length > 0 && (
                <div>
                  <b>Success looks like:</b> {m.successLooksLike.join(' · ')}
                </div>
              )}
              {m.outOfScope.length > 0 && (
                <div>
                  <b>Out of scope:</b> {m.outOfScope.join(' · ')}
                </div>
              )}
            </div>
          )}
        </div>
        {(m.successLooksLike.length > 0 || m.outOfScope.length > 0) && (
          <button className="btn ghost sm" onClick={() => setOpen(!open)}>
            {open ? 'Less' : 'More'}
          </button>
        )}
      </div>
      {tab ? (
        <div className="class-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`class-tab ${tab === t.id ? 'active' : ''}`} onClick={() => onTab(t.id)} data-testid={`tab-${t.id}`}>
              <Icon name={t.icon} size={15} /> {t.label}
            </button>
          ))}
        </div>
      ) : (
        <div style={{ height: 14 }} />
      )}
    </div>
  )
}

function ClassMenu({ onDelete }: { onDelete: () => void }): JSX.Element {
  return (
    <button className="btn ghost sm icon" title="Delete class" aria-label="Delete class" onClick={onDelete}>
      <Icon name="trash" size={15} />
    </button>
  )
}
