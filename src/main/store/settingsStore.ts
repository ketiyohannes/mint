import { join } from 'node:path'
import { USER_ERROR_PREFIX } from '@shared/api'
import type { SecretName, Settings, SettingsView } from '@shared/types'
import { DEFAULT_FOCUS, sanitizeFocus } from '@shared/focus'
import { DEFAULT_STUDY_DEPTH, isStudyDepth } from '@shared/depth'
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
  theme: 'light',
  lessonView: 'dock',
  studyDepth: DEFAULT_STUDY_DEPTH,
  tutorStyle: 'teach',
  focus: DEFAULT_FOCUS
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
  /** Decrypted secrets (null: none saved), so a turn does not read and decrypt the file again. */
  private secrets = new Map<SecretName, string | null>()
  /** Bumped by every secrets write, so a read that raced one is not cached. */
  private secretsVersion = 0
  /** Tail of the write queue: settings and secrets are written one at a time, in call order. */
  private writes: Promise<unknown> = Promise.resolve()

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

  /** Run a read-modify-write after the ones already queued (two overlapping writes could otherwise land out of order). */
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work, work)
    this.writes = run.catch(() => undefined)
    return run
  }

  update(patch: Partial<Settings>): Promise<Settings> {
    return this.queue(async () => {
      const next = sanitize({ ...(await this.get()), ...patch })
      await writeJson(this.settingsPath, next)
      this.cache = next
      return next
    })
  }

  setSecret(name: SecretName, value: string | null): Promise<void> {
    return this.queue(async () => {
      const plain = typeof value === 'string' && value.trim() ? value.trim() : null
      const secrets = await readJson<SecretsFile>(this.secretsPath, {})
      if (plain) {
        if (!this.cipher.available()) throw new Error(`${USER_ERROR_PREFIX}Secure storage is not available on this system, so keys cannot be saved.`)
        secrets[name] = this.cipher.encrypt(plain)
      } else {
        delete secrets[name]
      }
      await writeJson(this.secretsPath, secrets)
      this.secretsVersion++
      this.secrets.set(name, plain)
    })
  }

  /** Drop keys for features mint no longer has (the OpenAI key used by the old voice tutor). */
  forgetRetiredSecrets(): Promise<void> {
    return this.queue(async () => {
      const secrets = await readJson<Record<string, string>>(this.secretsPath, {})
      const keep = Object.fromEntries(Object.entries(secrets).filter(([name]) => SECRET_NAMES.includes(name as SecretName)))
      if (Object.keys(keep).length !== Object.keys(secrets).length) await writeJson(this.secretsPath, keep)
    })
  }

  async getSecret(name: SecretName): Promise<string | null> {
    if (this.secrets.has(name)) return this.secrets.get(name) ?? null
    const version = this.secretsVersion
    const stored = (await readJson<SecretsFile>(this.secretsPath, {}))[name]
    let plain: string | null = null
    if (stored) {
      try {
        plain = this.cipher.decrypt(stored)
      } catch {
        // The keychain may only be locked for now: answer "no key" without remembering it.
        return null
      }
    }
    if (version === this.secretsVersion) this.secrets.set(name, plain)
    return plain
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
    lessonView: s.lessonView === 'tab' ? 'tab' : 'dock',
    studyDepth: isStudyDepth(s.studyDepth) ? s.studyDepth : DEFAULT_STUDY_DEPTH,
    tutorStyle: s.tutorStyle === 'coach' ? 'coach' : 'teach',
    focus: sanitizeFocus(s.focus),
    claudeModel: (s.claudeModel ?? '').trim(),
    codexModel: (s.codexModel ?? '').trim()
  }
}

export function normalizeDomain(input: string): string {
  let d = String(input ?? '')
    .trim()
    .toLowerCase()
  d = d
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
    .replace(/:\d+$/, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : ''
}
