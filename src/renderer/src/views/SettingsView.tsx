import { useState, type JSX } from 'react'
import type { ProviderId, SecretName, Settings } from '@shared/types'
import { useApp } from '../state/app'
import { api } from '../lib/api'
import { Icon } from '../components/Icon'
import { ModelSelect } from '../components/ModelPicker'

export function SettingsView(): JSX.Element {
  const { settings, setSettings, run } = useApp()
  const [testing, setTesting] = useState<ProviderId | null>(null)
  const [test, setTest] = useState<{ provider: ProviderId; ok: boolean; message: string } | null>(null)
  const [anthropicKey, setAnthropicKey] = useState('')
  const [domain, setDomain] = useState('')

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

  const providers: { id: ProviderId; title: string; desc: string }[] = [
    { id: 'claude', title: 'Claude Agent SDK', desc: 'Uses your Claude login or an Anthropic API key.' },
    { id: 'codex', title: 'Codex app-server', desc: 'Uses your local `codex` CLI and its login.' },
    { id: 'demo', title: 'Demo (offline)', desc: 'Scripted answers to explore the app. Not a model.' }
  ]

  return (
    <>
      <div className="topbar">
        <div className="crumbs">
          <b>Settings</b>
        </div>
      </div>
      <div className="page">
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
                  <input id="ak" className="input" type="password" placeholder={settings.hasAnthropicKey ? '•••••••• saved' : 'sk-ant-…'} value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} />
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
              <span className="hint">Requires the `codex` CLI to be installed and logged in (`codex login`).</span>
            </div>
          )}

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
                {(['light', 'dark', 'system'] as const).map((t) => (
                  <button key={t} className={`tab ${settings.theme === t ? 'active' : ''}`} onClick={() => void update({ theme: t })}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
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
        </div>
      </div>
    </>
  )
}
