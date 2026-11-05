import { join } from 'node:path'
import type { SecretName, Settings, SettingsView } from '@shared/types'
import { readJson, writeJson } from './fsutil'

/** Curated starting allowlist for curricula built from public sources. */
export const DEFAULT_TRUSTED_DOMAINS = [
  'wikipedia.org',
  'britannica.com',
  'khanacademy.org',
  'ocw.mit.edu',
  'mit.edu',
  'stanford.edu',
  'plato.stanford.edu',
  'harvard.edu',
  'berkeley.edu',
  'ox.ac.uk',
  'cam.ac.uk',
  'openstax.org',
  'libretexts.org',
  'arxiv.org',
  'nature.com',
  'science.org',
  'ncbi.nlm.nih.gov',
  'nih.gov',
  'nasa.gov',
  'nist.gov',
  'who.int',
  'ourworldindata.org',
  'developer.mozilla.org',
  'docs.python.org',
  'mathworld.wolfram.com',
  'betterexplained.com',
  'quantamagazine.org',
  'gutenberg.org',
  '3blue1brown.com',
  'youtube.com'
]

export const DEFAULT_SETTINGS: Settings = {
  provider: 'claude',
  claudeModel: '',
  codexModel: '',
  trustedDomains: DEFAULT_TRUSTED_DOMAINS,
  theme: 'light'
}

/** Encrypts secrets at rest. Electron's safeStorage in the app; identity in tests. */
export interface SecretCipher {
  available(): boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

interface SecretsFile {
  anthropic?: string
}

export class SettingsStore {
  private cache: Settings | null = null

  constructor(
    private readonly dataDir: string,
    private readonly cipher: SecretCipher
  ) {}

  private get settingsPath(): string {
    return join(this.dataDir, 'settings.json')
  }

  private get secretsPath(): string {
    return join(this.dataDir, 'secrets.json')
  }

  async get(): Promise<Settings> {
    if (!this.cache) {
      const stored = await readJson<Partial<Settings>>(this.settingsPath, {})
      this.cache = sanitize({ ...DEFAULT_SETTINGS, ...stored })
    }
    return this.cache
  }

  async view(): Promise<SettingsView> {
    const [settings, secrets] = await Promise.all([this.get(), readJson<SecretsFile>(this.secretsPath, {})])
    return { ...settings, hasAnthropicKey: Boolean(secrets.anthropic), dataDir: this.dataDir }
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = sanitize({ ...(await this.get()), ...patch })
    this.cache = next
    await writeJson(this.settingsPath, next)
    return next
  }

  async setSecret(name: SecretName, value: string | null): Promise<void> {
    const secrets = await readJson<SecretsFile>(this.secretsPath, {})
    if (value && value.trim()) {
      if (!this.cipher.available()) throw new Error('mint:Secure storage is not available on this system, so keys cannot be saved.')
      secrets[name] = this.cipher.encrypt(value.trim())
    } else {
      delete secrets[name]
    }
    await writeJson(this.secretsPath, secrets)
  }

  /** Drop keys for features mint no longer has (the OpenAI key used by the old voice tutor). */
  async forgetRetiredSecrets(): Promise<void> {
    const secrets = await readJson<Record<string, string>>(this.secretsPath, {})
    const keep = Object.fromEntries(Object.entries(secrets).filter(([name]) => SECRET_NAMES.includes(name as SecretName)))
    if (Object.keys(keep).length !== Object.keys(secrets).length) await writeJson(this.secretsPath, keep)
  }

  async getSecret(name: SecretName): Promise<string | null> {
    const secrets = await readJson<SecretsFile>(this.secretsPath, {})
    const stored = secrets[name]
    if (!stored) return null
    try {
      return this.cipher.decrypt(stored)
    } catch {
      return null
    }
  }
}

const SECRET_NAMES: SecretName[] = ['anthropic']
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]

function sanitize(input: Settings): Settings {
  // Keep only known keys, so view-only fields (dataDir, has*Key) are never persisted.
  const s = Object.fromEntries(SETTING_KEYS.map((k) => [k, input[k]])) as unknown as Settings
  const provider = (['claude', 'codex', 'demo'] as const).includes(s.provider) ? s.provider : 'claude'
  const domains = Array.from(new Set((s.trustedDomains ?? []).map(normalizeDomain).filter(Boolean)))
  return {
    ...s,
    provider,
    trustedDomains: domains.length ? domains : DEFAULT_TRUSTED_DOMAINS,
    theme: (['light', 'dark', 'system'] as const).includes(s.theme) ? s.theme : 'light',
    claudeModel: (s.claudeModel ?? '').trim(),
    codexModel: (s.codexModel ?? '').trim()
  }
}

export function normalizeDomain(input: string): string {
  let d = String(input ?? '').trim().toLowerCase()
  d = d.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').replace(/:\d+$/, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : ''
}
