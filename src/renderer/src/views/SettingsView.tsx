import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ProviderId, SecretName, Settings, TutorStyle } from '@shared/types'
import { useApp } from '../state/app'
import { api, timeAgo } from '../lib/api'
import { useUpdates } from '../lib/useUpdates'
import { Icon } from '../components/Icon'
import { ModelSelect } from '../components/ModelPicker'
import { SHORTCUT_GROUPS, shortcutLabel } from '../lib/shortcuts'

export function SettingsView(): JSX.Element {
  const { settings, setSettings, run, route } = useApp()
  const [testing, setTesting] = useState<ProviderId | null>(null)
  const [test, setTest] = useState<{ provider: ProviderId; ok: boolean; message: string } | null>(null)
  const [anthropicKey, setAnthropicKey] = useState('')
  const [domain, setDomain] = useState('')

  // Opened on the shortcuts list: bring it to the top. Scrolls the page itself (scrollIntoView would move the app shell too).
  const pageRef = useRef<HTMLDivElement>(null)
  const shortcutsRef = useRef<HTMLHeadingElement>(null)
  const loaded = Boolean(settings)
  useEffect(() => {
    const page = pageRef.current
    const heading = shortcutsRef.current
    if (!loaded || route.name !== 'settings' || route.section !== 'shortcuts' || !page || !heading) return
    page.scrollTo({ top: heading.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop - 16 })
  }, [route, loaded])

  if (!settings) return <div className="page-inner empty">Loading…</div>

  const update = async (patch: Partial<Settings>) => {
    const s = await run(() => api.settings.update(patch))
    if (s) setSettings(s)
  }

  async function testProvider(p: ProviderId) {
    setTesting(p)
    const res = await run(() => api.settings.testProvider(p))
    setTesting(null)
    if (res) setTest({ provider: p, ...res })
  }

  async function saveKey(name: SecretName, value: string | null) {
    const s = await run(() => api.settings.setSecret(name, value), value ? 'Key saved securely.' : 'Key removed.')
    if (s) {
      setSettings(s)
      setAnthropicKey('')
    }
  }

  const providers: { id: ProviderId; title: string; desc: ReactNode }[] = [
    { id: 'claude', title: 'Claude Agent SDK', desc: 'Uses your Claude login or an Anthropic API key.' },
    {
      id: 'codex',
      title: 'Codex app-server',
      desc: (
        <>
          Uses your local <code>codex</code> CLI and its login.
        </>
      )
    },
    { id: 'demo', title: 'Demo (offline)', desc: 'Scripted answers to explore the app. Not a model.' }
  ]
  const tutorStyles: { id: TutorStyle; title: string; desc: string }[] = [
    { id: 'teach', title: 'Teach', desc: 'Explains every question in depth, in its own words, with your materials as the reference.' },
    { id: 'coach', title: 'Coach', desc: 'Least help first: a pointer, then a guiding question, a hint, and the full explanation when you ask.' }
  ]

  return (
    <>
      <div className="topbar">
        <div className="crumbs">
          <b>Settings</b>
        </div>
      </div>
      <div className="page" ref={pageRef}>
        <div className="page-inner page-narrow">
          <h1 className="page-title">Settings</h1>

          <h2 className="section-title">Agent harness</h2>
          <div className="radio-cards">
            {providers.map((p) => (
              <button key={p.id} className={`radio-card ${settings.provider === p.id ? 'on' : ''}`} onClick={() => void update({ provider: p.id })} data-testid={`provider-${p.id}`}>
                <b>{p.title}</b>
                <span className="small muted">{p.desc}</span>
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={testing !== null} onClick={() => testProvider(settings.provider)} data-testid="test-provider">
              {testing ? <span className="spinner" /> : <Icon name="shield" size={14} />} Test connection
            </button>
            {test && test.provider === settings.provider && (
              <span className="small" style={{ color: test.ok ? 'var(--primary)' : 'var(--danger)' }} data-testid="test-result">
                {test.ok ? '✓' : '✕'} {test.message}
              </span>
            )}
          </div>

          {settings.provider === 'claude' && (
            <div className="card" style={{ marginTop: 14 }}>
              <ModelSelect provider="claude" />
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="ak">Anthropic API key (optional)</label>
                <div className="row">
                  <input
                    id="ak"
                    className="input"
                    type="password"
                    placeholder={settings.hasAnthropicKey ? '•••••••• saved' : 'sk-ant-…'}
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                  />
                  <button className="btn" disabled={!anthropicKey.trim()} onClick={() => saveKey('anthropic', anthropicKey)}>
                    Save
                  </button>
                  {settings.hasAnthropicKey && (
                    <button className="btn ghost" onClick={() => saveKey('anthropic', null)}>
                      Remove
                    </button>
                  )}
                </div>
                <span className="hint">Without a key, mint uses the Claude login on this machine. Keys are encrypted with your system keychain.</span>
              </div>
            </div>
          )}
          {settings.provider === 'codex' && (
            <div className="card" style={{ marginTop: 14 }}>
              <ModelSelect provider="codex" />
              <span className="hint">
                Requires the <code>codex</code> CLI to be installed and logged in (<code>codex login</code>).
              </span>
            </div>
          )}

          <h2 className="section-title">How the tutor answers</h2>
          <div className="radio-cards">
            {tutorStyles.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={settings.tutorStyle === t.id}
                className={`radio-card ${settings.tutorStyle === t.id ? 'on' : ''}`}
                onClick={() => void update({ tutorStyle: t.id })}
                data-testid={`tutor-${t.id}`}
              >
                <b>{t.title}</b>
                <span className="small muted">{t.desc}</span>
              </button>
            ))}
          </div>

          <h2 className="section-title">Default trusted domains</h2>
          <div className="card stack">
            <span className="hint">New classes start with this list when building a curriculum from public sources. Each class keeps its own copy.</span>
            <div className="chips">
              {settings.trustedDomains.map((d) => (
                <span key={d} className="chip">
                  {d}
                  <button aria-label={`Remove ${d}`} onClick={() => void update({ trustedDomains: settings.trustedDomains.filter((x) => x !== d) })}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
            </div>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault()
                if (domain.trim()) void update({ trustedDomains: [...settings.trustedDomains, domain.trim()] }).then(() => setDomain(''))
              }}
            >
              <input className="input" placeholder="Add a domain, e.g. ocw.mit.edu" value={domain} onChange={(e) => setDomain(e.target.value)} />
              <button className="btn" disabled={!domain.trim()}>
                Add
              </button>
            </form>
          </div>

          <h2 className="section-title">Appearance and data</h2>
          <div className="card stack">
            <div className="row">
              <span style={{ width: 120 }}>Theme</span>
              <div className="tabs">
                {(
                  [
                    ['light', 'Light'],
                    ['dark', 'Dark'],
                    ['system', 'System']
                  ] as const
                ).map(([t, label]) => (
                  <button key={t} className={`tab ${settings.theme === t ? 'active' : ''}`} onClick={() => void update({ theme: t })} data-testid={`theme-${t}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="row">
              <span style={{ width: 120 }}>Lessons</span>
              <div className="tabs" role="radiogroup" aria-label="Where lessons show">
                {(
                  [
                    ['dock', 'Over the chat'],
                    ['tab', 'Study tab']
                  ] as const
                ).map(([view, label]) => (
                  <button
                    key={view}
                    role="radio"
                    aria-checked={settings.lessonView === view}
                    className={`tab ${settings.lessonView === view ? 'active' : ''}`}
                    onClick={() => void update({ lessonView: view })}
                    data-testid={`lessons-in-${view}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <span className="hint">
              {settings.lessonView === 'dock'
                ? `The open lesson’s brief, reading and checks float at the top of whichever chat you’re in. Drag its bar to move it anywhere over the chat, and fold it to one line with ${shortcutLabel('foldLesson')}.`
                : 'The open lesson’s brief, reading and checks show in the Study tab beside whichever chat you’re in.'}
            </span>
            <div className="row">
              <span style={{ width: 120 }}>Data folder</span>
              <code className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {settings.dataDir}
              </code>
              <button className="btn sm" onClick={() => void api.settings.openDataDir()}>
                <Icon name="folder" size={14} /> Open
              </button>
            </div>
            <span className="hint">Every class is a plain folder: MISSION.md, CURRICULUM.md, GLOSSARY.md, learning-records/, notes/ and your sources. It is yours.</span>
          </div>

          <h2 className="section-title" ref={shortcutsRef}>
            Keyboard shortcuts
          </h2>
          <div className="card shortcuts" data-testid="shortcuts">
            {SHORTCUT_GROUPS.map((group) => (
              <div key={group.title} className="shortcut-group">
                <div className="dlabel">{group.title}</div>
                {group.rows.map((row) => (
                  <div key={row.label} className="shortcut-row">
                    <span>{row.label}</span>
                    <span className="kbd">{row.keys}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <UpdatesCard />
        </div>
      </div>
    </>
  )
}

function UpdatesCard(): JSX.Element | null {
  const { status, check, download, install } = useUpdates()
  const [showNotes, setShowNotes] = useState(false)
  if (!status) return null
  const { state } = status

  let text: string
  switch (state.status) {
    case 'disabled':
      text = state.reason
      break
    case 'idle':
      text = 'mint checks for new versions in the background.'
      break
    case 'checking':
      text = 'Checking for updates…'
      break
    case 'current':
      text = `You have the latest version. Checked ${timeAgo(state.checkedAt)}.`
      break
    case 'available':
      text = `mint ${state.version} is available.`
      break
    case 'downloading':
      text = `Downloading mint ${state.version}… ${state.percent}%`
      break
    case 'ready':
      text = `mint ${state.version} is ready. It installs when you restart, or the next time mint quits.`
      break
    case 'error':
      text = state.message
      break
  }

  return (
    <>
      <h2 className="section-title">Updates</h2>
      <div className="card stack" data-testid="updates">
        <div className="row">
          <span style={{ width: 120 }}>Version</span>
          <code className="small" data-testid="app-version">
            {status.currentVersion}
          </code>
        </div>
        <div className="row">
          <span className="small muted" style={{ flex: 1 }} data-testid="update-status">
            {text}
          </span>
          {(state.status === 'available' || state.status === 'ready') && state.notes && (
            <button className="btn sm ghost" onClick={() => setShowNotes((s) => !s)} aria-expanded={showNotes} data-testid="update-notes-toggle">
              What's new
            </button>
          )}
          {(state.status === 'idle' || state.status === 'current' || state.status === 'error') && (
            <button className="btn sm" onClick={check} data-testid="update-check">
              <Icon name="refresh" size={14} /> Check for updates
            </button>
          )}
          {state.status === 'checking' && (
            <button className="btn sm" disabled>
              <span className="spinner" /> Checking
            </button>
          )}
          {state.status === 'available' && (
            <button className="btn sm primary" onClick={download} data-testid="update-download">
              <Icon name="update" size={14} /> Download and install
            </button>
          )}
          {state.status === 'ready' && (
            <button className="btn sm primary" onClick={install} data-testid="update-install">
              <Icon name="update" size={14} /> Restart to update
            </button>
          )}
        </div>
        {showNotes && (state.status === 'available' || state.status === 'ready') && state.notes && (
          <div className="update-notes small" data-testid="update-notes">
            {state.notes}
          </div>
        )}
        {state.status === 'downloading' && (
          <div className="progress-bar">
            <div style={{ width: `${state.percent}%` }} />
          </div>
        )}
      </div>
    </>
  )
}
