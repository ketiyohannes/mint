import { useEffect, useState, type JSX } from 'react'
import type { ProviderId, Settings } from '@shared/types'
import { useApp } from '../state/app'
import { api } from '../lib/api'
import { Icon } from '../components/Icon'
import { pickSystemVoice, speak } from '../lib/voice/tts'

const OPENAI_VOICES = ['coral', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']

export function SettingsView(): JSX.Element {
  const { settings, setSettings, run, toast } = useApp()
  const [testing, setTesting] = useState<ProviderId | null>(null)
  const [test, setTest] = useState<{ provider: ProviderId; ok: boolean; message: string } | null>(null)
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [domain, setDomain] = useState('')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])

  useEffect(() => {
    const load = () => setVoices(speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en')))
    load()
    speechSynthesis.addEventListener('voiceschanged', load)
    return () => speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

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

  async function saveKey(name: 'anthropic' | 'openai', value: string | null) {
    const s = await run(() => api.settings.setSecret(name, value), value ? 'Key saved securely.' : 'Key removed.')
    if (s) {
      setSettings(s)
      if (name === 'anthropic') setAnthropicKey('')
      else setOpenaiKey('')
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
              <div className="field">
                <label htmlFor="claude-model">Model (optional)</label>
                <input id="claude-model" className="input" placeholder="Default: the Claude Code default model" defaultValue={settings.claudeModel} onBlur={(e) => e.target.value !== settings.claudeModel && void update({ claudeModel: e.target.value })} />
              </div>
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
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="codex-model">Model (optional)</label>
                <input id="codex-model" className="input" placeholder="Default: your Codex default" defaultValue={settings.codexModel} onBlur={(e) => e.target.value !== settings.codexModel && void update({ codexModel: e.target.value })} />
                <span className="hint">Requires the `codex` CLI to be installed and logged in (`codex login`).</span>
              </div>
            </div>
          )}

          <h2 className="section-title">Voice tutor</h2>
          <div className="card stack">
            <div className="grid-2">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="stt">Speech to text</label>
                <select id="stt" className="select" value={settings.sttEngine} onChange={(e) => void update({ sttEngine: e.target.value as Settings['sttEngine'] })}>
                  <option value="local-whisper">Local Whisper (private, ~80 MB download once)</option>
                  <option value="openai">OpenAI (needs a key)</option>
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="tts">Text to speech</label>
                <select id="tts" className="select" value={settings.ttsEngine} onChange={(e) => void update({ ttsEngine: e.target.value as Settings['ttsEngine'], ttsVoice: '' })}>
                  <option value="system">System voice (offline)</option>
                  <option value="openai">OpenAI voice (natural, needs a key)</option>
                </select>
              </div>
            </div>
            <div className="grid-2">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="voice">Voice</label>
                <select id="voice" className="select" value={settings.ttsVoice} onChange={(e) => void update({ ttsVoice: e.target.value })}>
                  {settings.ttsEngine === 'openai' ? (
                    OPENAI_VOICES.map((v) => (
                      <option key={v} value={v === 'coral' ? '' : v}>
                        {v}
                        {v === 'coral' ? ' (default)' : ''}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="">Best available ({pickSystemVoice('')?.name ?? 'system default'})</option>
                      {voices.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name} ({v.lang})
                        </option>
                      ))}
                    </>
                  )}
                </select>
                <span className="hint">On macOS, download "Premium" voices in System Settings → Accessibility → Spoken Content for a much better tutor voice.</span>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="rate">Speaking rate: {settings.ttsRate.toFixed(2)}×</label>
                <input id="rate" type="range" min={0.6} max={1.6} step={0.05} value={settings.ttsRate} onChange={(e) => void update({ ttsRate: Number(e.target.value) })} />
              </div>
            </div>
            <label className="row">
              <input type="checkbox" checked={settings.speakReplies} onChange={(e) => void update({ speakReplies: e.target.checked })} /> Speak tutor replies aloud by default
            </label>
            <div className="row">
              <button
                className="btn sm"
                onClick={() => {
                  const s = speak('Hi. I will point you to the passage first. Then, if you need it, I will explain a little more. Does that sound good?', {
                    engine: settings.ttsEngine,
                    voice: settings.ttsVoice,
                    rate: settings.ttsRate,
                    onEnd: () => undefined
                  })
                  s.done.catch((err) => toast(String(err), 'error'))
                }}
              >
                <Icon name="volume" size={14} /> Try the voice
              </button>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="ok">OpenAI API key (only for cloud voice)</label>
              <div className="row">
                <input id="ok" className="input" type="password" placeholder={settings.hasOpenAIKey ? '•••••••• saved' : 'sk-…'} value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} />
                <button className="btn" disabled={!openaiKey.trim()} onClick={() => saveKey('openai', openaiKey)}>
                  Save
                </button>
                {settings.hasOpenAIKey && (
                  <button className="btn ghost" onClick={() => saveKey('openai', null)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

          <h2 className="section-title">Default trusted domains</h2>
          <div className="card stack">
            <span className="hint">New classes start with this list when building a curriculum from public sources. Each class can adjust its own copy in its Library.</span>
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
