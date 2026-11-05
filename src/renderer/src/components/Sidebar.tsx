import { useState, type JSX } from 'react'
import type { ClassBundle, SourceMeta } from '@shared/types'
import { useApp } from '../state/app'
import { api, timeAgo } from '../lib/api'
import { useUpdates } from '../lib/useUpdates'
import { Icon, type IconName } from './Icon'

export const KIND_ICON: Record<SourceMeta['kind'], IconName> = {
  pdf: 'pdf',
  web: 'globe',
  youtube: 'video',
  markdown: 'file',
  text: 'file',
  docx: 'file',
  html: 'globe'
}

/**
 * Classes like projects in a coding agent: open a folder to start one, and
 * the open class lists its chats (lessons are chats too).
 */
export function Sidebar({ bundle }: { bundle: ClassBundle | null }): JSX.Element {
  const { route, go, classes, jobs, run, refreshClasses } = useApp()
  const activeClass = route.name === 'class' ? route.classId : null
  const activeChat = route.name === 'class' ? route.chatId : undefined
  const [creating, setCreating] = useState(false)

  async function create(paths: string[]) {
    setCreating(true)
    const meta = await run(() => api.classes.start({ paths }))
    setCreating(false)
    if (!meta) return
    await refreshClasses()
    go({ name: 'class', classId: meta.id, chatId: null })
  }

  async function openFolder() {
    const paths = await api.system.pickMaterials()
    if (paths.length) await create(paths)
  }

  const chats = bundle ? bundle.threads.filter((t) => t.anchor.kind === 'general').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : []

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          mint
        </span>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => void openFolder()} disabled={creating} title="Open a folder of materials as a new class" aria-label="Open folder" data-testid="open-folder">
          {creating ? <span className="spinner tiny" /> : <Icon name="folderPlus" size={15} />}
        </button>
        <button className="icon-btn" onClick={() => void create([])} disabled={creating} title="New class without materials" aria-label="New class" data-testid="new-class">
          <Icon name="plus" size={15} />
        </button>
      </div>

      <div className="side-label">Classes</div>
      <nav className="class-list" aria-label="Classes">
        {classes.map((c) => {
          const active = activeClass === c.id
          const busy = jobs.some((j) => j.classId === c.id)
          return (
            <div key={c.id} className="class-group">
              <div className={`class-row ${active ? 'active' : ''}`}>
                <button className="class-open" onClick={() => go({ name: 'class', classId: c.id })} title={c.title} data-testid="sidebar-class">
                  <Icon name={active ? 'folderOpen' : 'folder'} size={14} />
                  <span className="ellipsis">{c.title}</span>
                </button>
                {busy ? <span className="spinner tiny" /> : c.reviewsDue > 0 ? <span className="count warn" title="Reviews due">{c.reviewsDue}</span> : null}
                <button className="icon-btn ghost-hover" title="New chat" aria-label={`New chat in ${c.title}`} onClick={() => go({ name: 'class', classId: c.id, chatId: null })} data-testid="new-chat">
                  <Icon name="compose" size={12} />
                </button>
              </div>
              {active && bundle && bundle.meta.id === c.id && (
                <div className="chat-list">
                  {chats.map((t) => (
                    <div key={t.id} className={`chat-row ${activeChat === t.id ? 'active' : ''}`} data-testid="sidebar-chat">
                      <button className="chat-open" onClick={() => go({ name: 'class', classId: c.id, chatId: t.id })} title={t.title}>
                        <span className="ellipsis">{t.title}</span>
                        <span className="chat-time">{timeAgo(t.updatedAt).replace(' ago', '')}</span>
                      </button>
                      <button
                        className="icon-btn ghost-hover"
                        aria-label={`Delete chat ${t.title}`}
                        title="Delete chat"
                        onClick={() => {
                          if (!window.confirm(`Delete the chat "${t.title}"?`)) return
                          if (activeChat === t.id) go({ name: 'class', classId: c.id, chatId: null })
                          void run(() => api.threads.remove(c.id, t.id))
                        }}
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </div>
                  ))}
                  {!chats.length && <div className="side-empty small">No chats yet</div>}
                </div>
              )}
            </div>
          )
        })}
        {!classes.length && <div className="side-empty">Open a folder of materials to start your first class.</div>}
      </nav>

      <div className="sidebar-foot">
        <UpdateRow />
        <button className={`class-row plain ${route.name === 'settings' ? 'active' : ''}`} onClick={() => go({ name: 'settings' })} data-testid="nav-settings">
          <Icon name="settings" size={14} /> Settings
        </button>
      </div>
    </aside>
  )
}

/** A new version, once found: download it, follow the download, then restart into it. */
function UpdateRow(): JSX.Element | null {
  const { status, download, install } = useUpdates()
  const state = status?.state
  if (state?.status === 'available') {
    return (
      <button className="class-row plain update-row" onClick={download} title={`mint ${state.version} is available`} data-testid="update-row">
        <Icon name="update" size={14} /> {state.installable ? 'Update mint' : 'Get the new mint'}
        <span className="update-row-note">{state.version}</span>
      </button>
    )
  }
  if (state?.status === 'downloading') {
    return (
      <div className="class-row plain update-row" data-testid="update-row">
        <span className="spinner" /> Downloading update
        <span className="update-row-note">{state.percent}%</span>
      </div>
    )
  }
  if (state?.status === 'ready') {
    return (
      <button className="class-row plain update-row" onClick={install} title={`Restart into mint ${state.version}`} data-testid="update-row">
        <Icon name="update" size={14} /> Restart to update
      </button>
    )
  }
  return null
}
