import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Read and parse a JSON file; returns `fallback` when the file does not exist. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    // A corrupt file must not brick the app: keep a copy and start fresh.
    const kept = `${path}.corrupt-${Date.now()}`
    const moved = await rename(path, kept).then(
      () => true,
      () => false
    )
    console.warn(`[mint] ${path} is not valid JSON, so mint starts it afresh${moved ? `; the old content is kept in ${kept}` : ''}`)
    return fallback
  }
}

/** Errors Windows gives while another handle (a reader, an indexer, antivirus) holds the file being replaced. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_RETRIES = 5
const RENAME_RETRY_MS = 25

/** Rename over `to`, waiting out a file that is briefly held open on Windows (state files are read without the class lock). */
async function renameOver(from: string, to: string, platform: NodeJS.Platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (err) {
      const busy = platform === 'win32' && BUSY_CODES.has((err as NodeJS.ErrnoException).code ?? '')
      if (!busy || attempt >= RENAME_RETRIES) throw err
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS * (attempt + 1)))
    }
  }
}

/** Write a file atomically (temp file + rename) so a crash never leaves half a file. A failed write leaves no temp file behind. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, platform: NodeJS.Platform = process.platform): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, data)
    await renameOver(tmp, path, platform)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2))
}

export async function removePath(path: string): Promise<void> {
  // Retries cover transient ENOTEMPTY/EBUSY (e.g. Spotlight or an editor touching a file mid-delete).
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
}

/**
 * Serializes async work per key. Every mutation of a class goes through
 * `lock(classId, ...)`, so concurrent IPC calls can never interleave
 * read-modify-write cycles on the same files.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return next
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function slugify(text: string, max = 48): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return slug || 'item'
}
