import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** How many of the next renames fail, and with which error code. */
const failing = vi.hoisted(() => ({ left: 0, code: 'EPERM' }))

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (failing.left > 0) {
        failing.left--
        throw Object.assign(new Error(`${failing.code}: operation not permitted, rename`), { code: failing.code })
      }
      return real.rename(from, to)
    }
  }
})

const { readJson, writeFileAtomic, writeJson } = await import('../../src/main/store/fsutil')

const dir = mkdtempSync(join(tmpdir(), 'mint-fsutil-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  failing.left = 0
  failing.code = 'EPERM'
})

const leftovers = (folder: string) => readdirSync(folder).filter((name) => name.endsWith('.tmp'))

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temp file', async () => {
    const folder = mkdtempSync(join(dir, 'plain-'))
    const file = join(folder, 'state.json')
    await writeJson(file, { a: 1 })
    await writeJson(file, { a: 2 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 })
    expect(readdirSync(folder)).toEqual(['state.json'])
  })

  it('on Windows waits out a file that is briefly held open', async () => {
    const folder = mkdtempSync(join(dir, 'busy-'))
    const file = join(folder, 'state.json')
    writeFileSync(file, 'old')
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      failing.left = 2
      failing.code = code
      await writeFileAtomic(file, code, 'win32')
      expect(readFileSync(file, 'utf8')).toBe(code)
    }
    expect(failing.left).toBe(0)
    expect(leftovers(folder)).toEqual([])
  })

  it('gives up after a few tries, keeping the old file and no temp file', async () => {
    const folder = mkdtempSync(join(dir, 'held-'))
    const file = join(folder, 'state.json')
    writeFileSync(file, 'old')
    failing.left = 100
    await expect(writeFileAtomic(file, 'new', 'win32')).rejects.toMatchObject({ code: 'EPERM' })
    expect(100 - failing.left).toBe(6) // the first try and five more
    expect(readFileSync(file, 'utf8')).toBe('old')
    expect(leftovers(folder)).toEqual([])
  })

  it('does not retry elsewhere, or for other errors', async () => {
    const folder = mkdtempSync(join(dir, 'other-'))
    const file = join(folder, 'state.json')
    failing.left = 1
    await expect(writeFileAtomic(file, 'x', 'darwin')).rejects.toMatchObject({ code: 'EPERM' })
    failing.left = 1
    failing.code = 'ENOSPC'
    await expect(writeFileAtomic(file, 'x', 'win32')).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(readdirSync(folder)).toEqual([])
  })

  it('removes its temp file when the target cannot be replaced', async () => {
    const folder = mkdtempSync(join(dir, 'blocked-'))
    const target = join(folder, 'state.json')
    mkdirSync(join(target, 'child'), { recursive: true }) // a non-empty folder where the file should go
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow()
    expect(leftovers(folder)).toEqual([])
  })
})

describe('readJson', () => {
  it('sets a corrupt file aside, says so, and starts afresh', async () => {
    const folder = mkdtempSync(join(dir, 'corrupt-'))
    const file = join(folder, 'threads.json')
    writeFileSync(file, '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await readJson(file, ['fallback'])).toEqual(['fallback'])
      expect(warn).toHaveBeenCalledTimes(1)
      const kept = readdirSync(folder).find((name) => name.startsWith('threads.json.corrupt-'))!
      expect(String(warn.mock.calls[0][0])).toContain(join(folder, kept))
      expect(readFileSync(join(folder, kept), 'utf8')).toBe('{ not json')
      // A missing file is not a corrupt one.
      expect(await readJson(file, ['fallback'])).toEqual(['fallback'])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
