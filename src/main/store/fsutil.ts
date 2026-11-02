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
    await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined)
    return fallback
  }
}

/** Write a file atomically (temp file + rename) so a crash never leaves half a file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2))
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
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
