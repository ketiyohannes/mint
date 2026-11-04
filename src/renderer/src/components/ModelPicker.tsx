import { useEffect, useRef, useState, type JSX } from 'react'
import type { ModelOption, ProviderId, Settings } from '@shared/types'
import { api, errorMessage } from '../lib/api'
import { useApp } from '../state/app'
import { Icon } from './Icon'

export const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', demo: 'Demo' }

/** Each provider remembers its own model; '' means the harness default. */
const MODEL_KEY: Record<Exclude<ProviderId, 'demo'>, 'claudeModel' | 'codexModel'> = { claude: 'claudeModel', codex: 'codexModel' }

interface ModelList {
  models: ModelOption[]
  loading: boolean
  error?: string
}

// One fetch per provider per session, shared by every picker.
const cache = new Map<ProviderId, Promise<{ models: ModelOption[]; error?: string }>>()

function loadModels(provider: ProviderId, refresh = false) {
  if (refresh || !cache.has(provider)) {
    const p = api.settings.models(provider, refresh).catch((err) => ({ models: [] as ModelOption[], error: errorMessage(err) }))
    cache.set(provider, p)
  }
  return cache.get(provider)!
}

/** The models a provider offers, loaded once and shared. */
export function useModels(provider: ProviderId): ModelList & { refresh: () => void } {
  const [state, setState] = useState<ModelList>({ models: [], loading: provider !== 'demo' })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (provider === 'demo') return setState({ models: [], loading: false })
    let live = true
    setState((s) => ({ ...s, loading: true }))
    void loadModels(provider, nonce > 0).then((r) => live && setState({ models: r.models, loading: false, error: r.error }))
    return () => {
      live = false
    }
  }, [provider, nonce])
  return { ...state, refresh: () => setNonce((n) => n + 1) }
}

/** The model a provider is set to, as stored in Settings ('' is the harness default). */
export function currentModel(settings: Settings, provider: ProviderId): string {
  return provider === 'demo' ? '' : settings[MODEL_KEY[provider]]
}

/** A short name for what is selected: the model's label, or the default's. */
export function modelLabel(models: ModelOption[], selected: string): string {
  const hit = selected ? models.find((m) => m.id === selected) : models.find((m) => m.isDefault)
  const label = hit?.label ?? (selected || 'Default')
  return label.replace(/\s*\(recommended\)\s*$/i, '')
}

/** Is this row the current choice? The default row stands for an empty setting. */
function isSelected(m: ModelOption, selected: string): boolean {
  return selected ? m.id === selected : Boolean(m.isDefault)
}

/** Save a choice: picking the harness default clears the override. */
function useChooseModel(provider: ProviderId) {
  const { setSettings, toast } = useApp()
  return async (m: ModelOption | string) => {
    if (provider === 'demo') return
    const id = typeof m === 'string' ? m.trim() : m.isDefault ? '' : m.id
    try {
      setSettings(await api.settings.update({ [MODEL_KEY[provider]]: id }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }
}

/**
 * The provider · model pill in the prompt box. Opens a menu with the models
 * the current harness offers; the choice applies to every class.
 */
export function ModelPicker(): JSX.Element | null {
  const { settings, go } = useApp()
  const provider = settings?.provider ?? 'claude'
  const { models, loading, error, refresh } = useModels(provider)
  const choose = useChooseModel(provider)
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!settings) return null
  const selected = currentModel(settings, provider)
  const unlisted = selected && !models.some((m) => m.id === selected)

  return (
    <div className="menu-anchor" ref={ref}>
      <button className="provider-pill" onClick={() => setOpen((o) => !o)} title="Choose the model" aria-haspopup="menu" aria-expanded={open} data-testid="model-picker">
        <Icon name="sparkle" size={12} />
        {PROVIDER_LABEL[provider]}
        {provider !== 'demo' && <span className="muted">· {modelLabel(models, selected)}</span>}
        <Icon name="caret" size={10} />
      </button>
      {open && (
        <div className="menu up model-menu" role="menu" data-testid="model-menu">
          <div className="model-menu-head">
            <span>{PROVIDER_LABEL[provider]} models</span>
            {provider !== 'demo' && (
              <button className="icon-btn" onClick={refresh} title="Ask the harness again" aria-label="Refresh models">
                {loading ? <span className="spinner tiny" /> : <Icon name="refresh" size={12} />}
              </button>
            )}
          </div>
          {provider === 'demo' ? (
            <div className="model-menu-note">Demo mode is scripted and has no models.</div>
          ) : (
            <div className="model-list">
              {models.map((m) => (
                <button
                  key={m.id}
                  role="menuitemradio"
                  aria-checked={isSelected(m, selected)}
                  className={`model-row ${isSelected(m, selected) ? 'on' : ''}`}
                  onClick={() => {
                    void choose(m)
                    setOpen(false)
                  }}
                  data-testid="model-option"
                >
                  <span className="model-check">{isSelected(m, selected) && <Icon name="check" size={12} />}</span>
                  <span className="model-text">
                    <span className="model-name">{m.label}</span>
                    {m.description && <span className="model-desc">{m.description}</span>}
                  </span>
                </button>
              ))}
              {unlisted && (
                <div className="model-row on" aria-checked>
                  <span className="model-check">
                    <Icon name="check" size={12} />
                  </span>
                  <span className="model-text">
                    <span className="model-name">{selected}</span>
                    <span className="model-desc">Custom model id</span>
                  </span>
                </div>
              )}
              {loading && !models.length && (
                <div className="model-menu-note">
                  <span className="spinner tiny" /> Asking {PROVIDER_LABEL[provider]} for its models…
                </div>
              )}
              {error && !models.length && <div className="model-menu-note warn">{error}</div>}
            </div>
          )}
          {provider !== 'demo' &&
            (custom === null ? (
              <button className="menu-item" onClick={() => setCustom(selected)}>
                <Icon name="compose" size={13} /> Custom model id…
              </button>
            ) : (
              <form
                className="model-custom"
                onSubmit={(e) => {
                  e.preventDefault()
                  void choose(custom)
                  setCustom(null)
                  setOpen(false)
                }}
              >
                <input className="input sm" autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. claude-opus-5" data-testid="model-custom" />
              </form>
            ))}
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false)
              go({ name: 'settings' })
            }}
          >
            <Icon name="settings" size={13} /> Switch harness in Settings…
          </button>
        </div>
      )}
    </div>
  )
}

/** The model field in Settings: the same list as a select, with a custom id. */
export function ModelSelect({ provider }: { provider: Exclude<ProviderId, 'demo'> }): JSX.Element | null {
  const { settings } = useApp()
  const { models, loading, error, refresh } = useModels(provider)
  const choose = useChooseModel(provider)
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  if (!settings) return null
  const selected = currentModel(settings, provider)
  const listed = models.find((m) => isSelected(m, selected))
  const value = customDraft !== null || (selected && !listed) ? '__custom__' : (listed?.id ?? '')

  return (
    <div className="field">
      <label htmlFor={`${provider}-model`}>Model</label>
      <div className="row">
        <select
          id={`${provider}-model`}
          className="select"
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__custom__') return setCustomDraft(selected)
            setCustomDraft(null)
            const m = models.find((x) => x.id === v)
            void choose(m ?? '')
          }}
          data-testid={`${provider}-model`}
        >
          {!models.length && <option value="">{loading ? 'Loading models…' : 'Harness default'}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.description ? ` · ${m.description}` : ''}
            </option>
          ))}
          <option value="__custom__">Custom model id…</option>
        </select>
        <button className="btn icon" onClick={refresh} title="Ask the harness again" aria-label="Refresh models">
          {loading ? <span className="spinner tiny" /> : <Icon name="refresh" size={14} />}
        </button>
      </div>
      {value === '__custom__' && (
        <input
          className="input"
          style={{ marginTop: 6 }}
          defaultValue={customDraft ?? selected}
          placeholder="Model id, e.g. claude-opus-5"
          onBlur={(e) => {
            if (e.target.value.trim() !== selected) void choose(e.target.value)
            if (!e.target.value.trim()) setCustomDraft(null)
          }}
          data-testid={`${provider}-model-custom`}
        />
      )}
      <span className="hint">{error && !models.length ? `Could not list models: ${error}` : 'Applies to every class. Each harness remembers its own model.'}</span>
    </div>
  )
}
