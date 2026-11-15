import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCore, type MintCore } from '../../src/main/app'
import type { ProviderId } from '@shared/types'

/**
 * Live run of simple mode and quick mode against a real harness.
 * Skipped unless MINT_LIVE=claude or MINT_LIVE=codex (costs model usage).
 */
const provider = process.env.MINT_LIVE as ProviderId | undefined
const root = resolve(import.meta.dirname, '../..')

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms: number): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 500))
  }
}

describe.skipIf(provider !== 'claude' && provider !== 'codex')(`live modes: ${provider}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-live-modes-'))
  const core: MintCore = createCore({
    dataDir: dir,
    cipher: { available: () => true, encrypt: (p) => p, decrypt: (c) => c },
    emitter: { stream: () => undefined, progress: () => undefined, classChanged: () => undefined },
    host: { platform: 'darwin', pickFiles: async () => [], openPath: async () => undefined, openExternal: async () => undefined },
    log: (m) => console.log(m)
  })

  afterAll(async () => {
    await core.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists what a paper contains, and explains an item from it', async () => {
    await core.handlers.settings.update({ provider })
    const meta = await core.handlers.classes.start({ paths: [join(root, 'tests/fixtures/e2e/eigen.md')], mode: 'simple' })
    const b = await until(async () => {
      const x = await core.handlers.classes.get(meta.id)
      return x.contents ? x : null
    }, 600_000)
    console.log('contents:', b.contents!.summary, JSON.stringify(b.contents!.items.map((i) => [i.title, i.summary, i.sources.map((s) => s.section)])))
    expect(b.contents!.items.length).toBeGreaterThan(2)
    // The list is of ideas, each tied to a real place in the source.
    expect(b.contents!.items.every((i) => i.sources.length > 0)).toBe(true)

    const t = await core.handlers.chat.command({ classId: meta.id, command: 'explain', arg: b.contents!.items[1].id, streamId: 'live-explain' })
    const reply = t.messages.at(-1)!
    console.log('explanation:', reply.text)
    expect(reply.error).toBeFalsy()
    expect(reply.text.length).toBeGreaterThan(300)
    expect(reply.text).not.toMatch(/\blesson|curriculum\b/i)
  }, 900_000)

  it('writes a short course that reads like an article', async () => {
    const meta = await core.handlers.classes.start({ mode: 'quick' })
    const t = await core.handlers.chat.send({ classId: meta.id, message: 'How does binary search work? I know basic Python.', streamId: 'live-quick', minutes: 5 })
    console.log('chat:', t.messages.at(-1)?.text)
    const course = await until(async () => {
      const c = (await core.handlers.classes.get(meta.id)).quickCourse
      return c && c.status !== 'writing' ? c : null
    }, 900_000)
    console.log('course:', course.title, '|', course.summary, '|', course.minutes, 'min |', course.status, course.error ?? '')
    for (const s of course.sections) console.log(`--- ${s.title} (${s.minutes} min, ${s.body?.split(/\s+/).length ?? 0} words)\n${s.body}`)
    expect(course.status).toBe('ready')
    expect(course.minutes).toBeLessThanOrEqual(8)
    // Prose from the first line (mint shows the title), with code for a subject done in code.
    expect(course.sections.every((s) => s.body && !/^#/.test(s.body))).toBe(true)
    expect(course.sections.some((s) => s.body!.includes('```python'))).toBe(true)

    const asked = await core.handlers.chat.send({ classId: meta.id, threadId: t.id, message: 'Why must the list be sorted?', streamId: 'live-quick-ask' })
    const reply = asked.messages.at(-1)!
    console.log('answer:', reply.text)
    expect(reply.error).toBeFalsy()
    // No materials to cite, and none to apologize for.
    expect(reply.text).not.toContain('[[cite:')
    expect(reply.text).not.toMatch(/outside your materials/i)
  }, 1_200_000)
})
