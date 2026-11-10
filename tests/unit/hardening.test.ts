import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCore, type MintCore } from '../../src/main/app'
import { expandPaths } from '../../src/main/sources/expand'
import { SettingsStore } from '../../src/main/store/settingsStore'
import { createFixtureFetch } from '../../src/main/testing/fixtureFetch'
import type { SourceProposal, TopicProgress } from '@shared/types'

/** Edge cases of the main process: races, interrupted work, and input the renderer should never send. */
const root = resolve(import.meta.dirname, '../..')
const WIKI = 'https://en.wikipedia.org/wiki/Linear_algebra'
let dir: string
let core: MintCore

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

function fixtureFetch(): typeof fetch {
  const map = join(dir, 'fixtures.json')
  writeFileSync(map, JSON.stringify({ [WIKI]: join(root, 'tests/fixtures/sources/article.html') }))
  return createFixtureFetch(map)
}

function newCore(dataDir: string, fetchImpl: typeof fetch = fixtureFetch()): MintCore {
  return createCore({
    dataDir,
    cipher: { available: () => true, encrypt: (p) => p, decrypt: (c) => c },
    fetchImpl,
    emitter: { stream: () => undefined, progress: () => undefined, classChanged: () => undefined },
    host: { platform: 'darwin', pickFiles: async () => [], openPath: async () => undefined, openExternal: async () => undefined }
  })
}

const mission = { topic: 'Linear algebra', why: 'Read ML papers.', successLooksLike: [], constraints: [], outOfScope: [] }
const intake = { timeline: '', timePerWeek: '', sessionLength: '30 minutes', priorExperience: '', preferences: '', materialsMode: 'own' as const }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mint-hardening-'))
  core = newCore(join(dir, 'data'))
  await core.handlers.settings.update({ provider: 'demo' })
})

afterAll(async () => {
  await core.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('folder expansion at the file limit', () => {
  const fill = (folder: string, count: number) => {
    mkdirSync(folder, { recursive: true })
    for (let i = 0; i < count; i++) writeFileSync(join(folder, `n${i}.md`), '# x')
  }

  it('says so when a later folder was left out', async () => {
    const f = join(dir, 'big')
    fill(join(f, 'a'), 60)
    fill(join(f, 'b'), 1)
    const { files, truncated } = await expandPaths([f])
    expect(files).toHaveLength(60)
    expect(truncated).toBe(true)
  })

  it('does not say so when exactly the limit was found', async () => {
    const f = join(dir, 'exact')
    fill(join(f, 'a'), 60)
    mkdirSync(join(f, 'b'))
    writeFileSync(join(f, 'b', 'image.png'), 'x')
    const { files, truncated } = await expandPaths([f])
    expect(files).toHaveLength(60)
    expect(truncated).toBe(false)
  })
})

describe('a class started with materials', () => {
  const send = (classId: string, message: string) => core.handlers.chat.send({ classId, message, streamId: `s${Math.random()}` })
  let classId = ''
  let sourceId = ''

  it('holds the intake until the materials are imported, then plans from them', async () => {
    const meta = await core.handlers.classes.start({ title: 'Eigen', paths: [join(root, 'tests/fixtures/e2e/eigen.md')] })
    classId = meta.id
    // No waiting for the import: the first message is sent at once.
    const t = await send(classId, 'Teach me eigenvectors')
    const q = t.messages.at(-1)!
    expect(q.widget?.kind).toBe('questions')
    expect(q.text).toContain('I can see 1 source')

    const answered = await core.handlers.chat.answer({ classId, threadId: t.id, messageId: q.id, answer: { kind: 'questions', skip: true } })
    expect(answered.messages.at(-1)!.text).toMatch(/reading your materials/)
    const planned = await until(async () => {
      const b = await core.handlers.classes.get(classId)
      return b.curriculum ? b : null
    })
    expect(planned.sourceProposals).toEqual([])
    sourceId = planned.sources[0].id
  })

  it('a named lesson that matches nothing is an error, not the next lesson', async () => {
    await expect(core.handlers.chat.command({ classId, command: 'lesson', arg: 'nothing like this' })).rejects.toThrow(/No lesson matches "nothing like this"/)
    expect((await core.handlers.classes.get(classId)).sessions).toEqual([])
    const topic = (await core.handlers.classes.get(classId)).curriculum!.milestones[0].topics[0]
    const byId = await core.handlers.chat.command({ classId, command: 'lesson', arg: topic.id })
    expect(byId.title).toBe(`Lesson: ${topic.title}`)
  })

  it('keeps the progress of a topic a re-plan dropped, out of sight until it returns', async () => {
    const ghost: TopicProgress = {
      topicId: 'dropped-topic',
      status: 'mastered',
      checks: { explain: { passed: true }, apply: { passed: true }, distinguish: { passed: true } },
      reviewStage: 2,
      nextReviewAt: '2020-01-01T00:00:00.000Z'
    }
    await core.kernel.repo.lock(classId, async () => {
      await core.kernel.repo.update(classId, 'progress', (p) => ({ ...p, [ghost.topicId]: ghost }))
      await core.kernel.refreshProgress(classId)
    })
    expect((await core.kernel.repo.read(classId, 'progress'))[ghost.topicId]).toEqual(ghost)
    const b = await core.handlers.classes.get(classId)
    expect(b.progress[ghost.topicId]).toBeUndefined()
    expect(b.reviewsDue).not.toContain(ghost.topicId)
    expect(Object.keys(b.progress).length).toBeGreaterThan(0)
  })

  it('stores an annotation only on real blocks, in its known shape', async () => {
    const doc = await core.handlers.sources.get(classId, sourceId)
    const block = doc.sections[0].blocks[0]
    const anchor = { kind: 'source' as const, sourceId, sectionLabel: doc.sections[0].label, quote: 'q', ranges: [{ blockId: block.id, start: 0, end: 3, extra: 'x' }] }
    await expect(core.handlers.annotations.create(classId, { ...anchor, ranges: [{ blockId: 'nope', start: 0, end: 3 }] }, 'highlight')).rejects.toThrow(/could not be located/)
    await expect(core.handlers.annotations.create(classId, { ...anchor, sourceId: 'src_missing' }, 'highlight')).rejects.toThrow(/missing/)
    await expect(core.handlers.annotations.create(classId, { ...anchor, quote: undefined as never }, 'note', 7 as never)).resolves.toBeUndefined()
    const saved = (await core.handlers.classes.get(classId)).annotations
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ kind: 'note', text: '7', anchor: { sourceId, quote: '', ranges: [{ blockId: block.id, start: 0, end: 3 }] } })
    expect(Object.keys(saved[0].anchor.ranges[0])).toEqual(['blockId', 'start', 'end'])
  })

  it('rejects input of the wrong shape with a plain message', async () => {
    await expect(core.handlers.threads.create({ classId, anchor: { kind: 'general' }, message: undefined as never, streamId: 's1' })).rejects.toThrow(/Type your question first/)
    await expect(core.handlers.threads.send({ classId, threadId: 'thr_x', message: { text: 'x' } as never, streamId: 's2' })).rejects.toThrow(/no longer exists/)
    await expect(core.handlers.sources.setTranscript(classId, sourceId, '0:00 Hello there')).rejects.toThrow(/Only a video/)
    await expect(core.handlers.sources.setTranscript(classId, sourceId, undefined as never)).rejects.toThrow(/Paste the transcript/)
    // Not a list of paths: treated as none given, so the (empty) picker result is used.
    await expect(core.handlers.sources.addFiles(classId, 'abc' as never)).resolves.toEqual({ added: [], errors: [] })
    expect((await core.handlers.sources.get(classId, sourceId)).kind).toBe('markdown')
  })

  it('stores a diagram with only the known, bounded shape of its anchor', async () => {
    const raw = {
      kind: 'source',
      sourceId,
      sectionLabel: 'Intro',
      quote: 'q'.repeat(5000),
      ranges: [
        { blockId: 's0b0', start: 0, end: 2 },
        { blockId: 's0b0', start: 5, end: 1 }
      ],
      junk: 'x'.repeat(10_000)
    }
    const made = await core.handlers.diagrams.create(classId, 'a stretching vector', raw as never)
    expect(Object.keys(made.anchor!).sort()).toEqual(['kind', 'quote', 'ranges', 'sectionLabel', 'sourceId'])
    expect(made.anchor).toMatchObject({ kind: 'source', sourceId, ranges: [{ blockId: 's0b0', start: 0, end: 2 }] })
    expect(made.anchor?.kind === 'source' && made.anchor.quote.length).toBe(2000)
    const plain = await core.handlers.diagrams.create(classId, 'another', { kind: 'bogus' } as never)
    expect(plain.anchor).toBeUndefined()
  })
})

describe('work that outlives its class', () => {
  it('cannot bring a deleted class folder back', async () => {
    const meta = await core.handlers.classes.create({ title: 'Short-lived', mission, intake })
    const folder = core.kernel.repo.dir(meta.id)
    const thread = await core.handlers.chat.command({ classId: meta.id, command: 'quiz', arg: 'anything' })
    expect(existsSync(join(folder, 'state', 'threads.json'))).toBe(true)

    await core.handlers.classes.remove(meta.id)
    expect(existsSync(folder)).toBe(false)
    await expect(core.kernel.repo.write(meta.id, 'threads', [])).rejects.toThrow(/no longer exists/)
    await expect(core.handlers.threads.setPinned(meta.id, thread.id, true)).rejects.toThrow(/no longer exists/)
    await expect(core.handlers.sources.resolveProposals(meta.id, ['prop_x'], [])).rejects.toThrow(/no longer exists/)
    expect(existsSync(folder)).toBe(false)
  })
})

describe('an import cut off by quitting', () => {
  it('turns a proposal left "approved" into a failed one that can be approved again', async () => {
    const meta = await core.handlers.classes.create({ title: 'Interrupted', mission, intake })
    const stuck: SourceProposal = { id: 'prop_stuck', title: 'Linear algebra', url: WIKI, domain: 'en.wikipedia.org', kind: 'web', why: 'w', covers: 'c', newDomain: false, status: 'approved' }
    const waiting: SourceProposal = { ...stuck, id: 'prop_waiting', status: 'proposed' }
    await core.kernel.repo.write(meta.id, 'proposals', [stuck, waiting])

    const opened = await core.handlers.classes.get(meta.id)
    expect(opened.sourceProposals).toMatchObject([
      { id: 'prop_stuck', status: 'failed', error: expect.stringMatching(/interrupted/) },
      { id: 'prop_waiting', status: 'proposed' }
    ])

    await core.handlers.sources.resolveProposals(meta.id, ['prop_stuck'], [])
    const after = await core.handlers.classes.get(meta.id)
    expect(after.sourceProposals[0]).toMatchObject({ id: 'prop_stuck', status: 'imported' })
    expect(after.sources).toHaveLength(1)
  })

  it('leaves a proposal alone while this run is importing it', async () => {
    // A download that waits until the test lets it through.
    let letThrough = (): void => undefined
    const gate = new Promise<void>((r) => (letThrough = r))
    const real = fixtureFetch()
    const slow = newCore(join(dir, 'data-slow'), (async (...args: Parameters<typeof fetch>) => {
      await gate
      return real(...args)
    }) as typeof fetch)
    try {
      await slow.handlers.settings.update({ provider: 'demo' })
      const meta = await slow.handlers.classes.create({ title: 'Importing', mission, intake })
      const p: SourceProposal = { id: 'prop_live', title: 'Linear algebra', url: WIKI, domain: 'en.wikipedia.org', kind: 'web', why: 'w', covers: 'c', newDomain: false, status: 'proposed' }
      await slow.kernel.repo.write(meta.id, 'proposals', [p])
      const importing = slow.handlers.sources.resolveProposals(meta.id, [p.id], [])
      await until(async () => (await slow.kernel.repo.read(meta.id, 'proposals'))[0].status === 'approved')
      // The class is opened for the first time in this run while the import is under way.
      expect((await slow.handlers.classes.get(meta.id)).sourceProposals[0]).toMatchObject({ status: 'approved' })
      letThrough()
      await importing
      expect((await slow.handlers.classes.get(meta.id)).sourceProposals[0].status).toBe('imported')
    } finally {
      letThrough()
      await slow.dispose()
    }
  })
})

describe('agent runtimes', () => {
  it('release keeps the shared runtime, even when the provider changed meanwhile, and disposes one made for the caller', async () => {
    await core.handlers.settings.update({ provider: 'codex' })
    const shared = await core.kernel.runtime('codex')
    const sharedDispose = vi.spyOn(shared, 'dispose')
    // The learner switches provider while a connection test on Codex is still running.
    await core.handlers.settings.update({ provider: 'demo' })
    await core.kernel.release(shared)
    expect(sharedDispose).not.toHaveBeenCalled()
    await core.handlers.settings.update({ provider: 'codex' })
    expect(await core.kernel.runtime()).toBe(shared)

    const own = await core.kernel.runtime('claude')
    expect(own).not.toBe(shared)
    const ownDispose = vi.spyOn(own, 'dispose')
    await core.kernel.release(own)
    expect(ownDispose).toHaveBeenCalledTimes(1)
    await core.handlers.settings.update({ provider: 'demo' })
  })
})

describe('quitting', () => {
  it('writes exports still waiting on their timer', async () => {
    const other = newCore(join(dir, 'data-quit'))
    await other.handlers.settings.update({ provider: 'demo' })
    const meta = await other.handlers.classes.create({ title: 'Quit soon', mission, intake })
    await other.handlers.notes.save(meta.id, { kind: 'note', title: 'Last words', body: 'Saved just before quitting.' })
    const folder = other.kernel.repo.dir(meta.id)
    await other.dispose()
    expect(readFileSync(join(folder, 'MISSION.md'), 'utf8')).toContain('Linear algebra')
    const notes = readdirSync(join(folder, 'notes'))
    expect(notes).toHaveLength(1)
    expect(readFileSync(join(folder, 'notes', notes[0]), 'utf8')).toContain('Saved just before quitting.')
  })
})

describe('settings store under concurrent use', () => {
  it('applies overlapping updates in call order, and the file ends up with all of them', async () => {
    const d = mkdtempSync(join(dir, 'settings-'))
    const store = new SettingsStore(d, { available: () => true, encrypt: (p) => p, decrypt: (c) => c })
    const updates = Array.from({ length: 12 }, (_, i) => store.update(i % 2 ? { claudeModel: `m${i}` } : { codexModel: `m${i}` }))
    const last = (await Promise.all(updates)).at(-1)!
    expect(last).toMatchObject({ codexModel: 'm10', claudeModel: 'm11' })
    expect(JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'))).toMatchObject({ codexModel: 'm10', claudeModel: 'm11' })
    expect(await store.get()).toMatchObject({ codexModel: 'm10', claudeModel: 'm11' })
  })

  it('remembers a decrypted secret and forgets it when the secret changes', async () => {
    const d = mkdtempSync(join(dir, 'secrets-'))
    let decrypted = 0
    const store = new SettingsStore(d, {
      available: () => true,
      encrypt: (p) => `enc:${p}`,
      decrypt: (c) => {
        decrypted++
        return c.slice(4)
      }
    })
    expect(await store.getSecret('anthropic')).toBeNull()
    await store.setSecret('anthropic', ' sk-one ')
    expect(await store.getSecret('anthropic')).toBe('sk-one')
    expect(await store.getSecret('anthropic')).toBe('sk-one')
    expect(decrypted).toBe(0) // the value just saved is known without reading it back

    // A read that overlaps a write must not pin the old value.
    const [, during] = await Promise.all([store.setSecret('anthropic', 'sk-two'), store.getSecret('anthropic')])
    expect(['sk-one', 'sk-two']).toContain(during)
    expect(await store.getSecret('anthropic')).toBe('sk-two')

    await store.setSecret('anthropic', null)
    expect(await store.getSecret('anthropic')).toBeNull()
    expect((await store.view()).hasAnthropicKey).toBe(false)

    // A fresh store (the next launch) reads and decrypts once, then remembers.
    await store.setSecret('anthropic', 'sk-three')
    const next = new SettingsStore(d, { available: () => true, encrypt: (p) => `enc:${p}`, decrypt: (c) => (decrypted++, c.slice(4)) })
    expect(await next.getSecret('anthropic')).toBe('sk-three')
    expect(await next.getSecret('anthropic')).toBe('sk-three')
    expect(decrypted).toBe(1)
  })

  it('does not remember a secret it could not decrypt', async () => {
    const d = mkdtempSync(join(dir, 'locked-'))
    writeFileSync(join(d, 'secrets.json'), JSON.stringify({ anthropic: 'enc:sk' }))
    let locked = true
    const store = new SettingsStore(d, {
      available: () => true,
      encrypt: (p) => `enc:${p}`,
      decrypt: (c) => {
        if (locked) throw new Error('keychain is locked')
        return c.slice(4)
      }
    })
    expect(await store.getSecret('anthropic')).toBeNull()
    locked = false
    expect(await store.getSecret('anthropic')).toBe('sk')
  })
})
