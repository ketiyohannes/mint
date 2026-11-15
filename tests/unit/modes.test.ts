import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCore, type MintCore } from '../../src/main/app'
import { validateContents } from '../../src/main/learning/contents'
import { cleanMinutes, cleanSectionBody, validateQuickPlan } from '../../src/main/learning/quick'
import { describeClass } from '../../src/main/jobs/context'
import { classMode, quickStreamId, quickStreamSection, readingTime } from '@shared/mode'
import type { ClassBundle, SourceMeta, StreamEvent } from '@shared/types'

/** Simple mode (a list of what the materials contain) and quick mode (a short written course). */
const root = resolve(import.meta.dirname, '../..')
let dir: string
let core: MintCore
const streams: StreamEvent[] = []

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const bundle = (id: string): Promise<ClassBundle> => core.handlers.classes.get(id)
const send = (classId: string, message: string, extra: { threadId?: string; minutes?: number } = {}) => core.handlers.chat.send({ classId, message, streamId: `s${Math.random()}`, ...extra })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mint-modes-'))
  core = createCore({
    dataDir: join(dir, 'data'),
    cipher: { available: () => true, encrypt: (p) => p, decrypt: (c) => c },
    emitter: { stream: (e) => streams.push(e), progress: () => undefined, classChanged: () => undefined },
    host: { platform: 'darwin', pickFiles: async () => [], openPath: async () => undefined, openExternal: async () => undefined }
  })
  await core.handlers.settings.update({ provider: 'demo' })
})

afterAll(async () => {
  await core.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('the list of contents, checked by code', () => {
  const source = (id: string, sectionLabels: string[]) => ({ meta: { id, title: `Source ${id}` } as SourceMeta, sectionLabels })
  const sources = [source('src_a', ['Abstract', 'p. 2', 'Attention'])]

  it('drops empty and repeated titles, and gives every item its own id', () => {
    const out = validateContents(
      {
        summary: '  A paper   about attention. ',
        items: [
          { title: 'Self-attention', summary: 'How a token looks at the others.', sources: [] },
          { title: '  ', summary: 'no title', sources: [] },
          { title: 'self-attention', summary: 'again', sources: [] },
          { title: 'Self attention!', summary: 'same slug, another title', sources: [] }
        ]
      },
      sources,
      null
    )
    expect(out.summary).toBe('A paper about attention.')
    expect(out.items.map((i) => i.title)).toEqual(['Self-attention', 'Self attention!'])
    expect(new Set(out.items.map((i) => i.id)).size).toBe(2)
  })

  it('points references at real sources and sections', () => {
    const out = validateContents(
      {
        summary: '',
        items: [
          {
            title: 'Attention',
            summary: '',
            sources: [
              { sourceId: 'src_a', section: 'page 2' },
              { sourceId: 'src_missing', section: 'Abstract' },
              { sourceId: 'src_a', section: 'No such heading' },
              { sourceId: 'src_a', section: 'p.2' }
            ]
          }
        ]
      },
      sources,
      null
    )
    // A page written another way is that page; an unknown section is the start; a source that is gone is dropped.
    expect(out.items[0].sources).toEqual([
      { sourceId: 'src_a', section: 'p. 2' },
      { sourceId: 'src_a', section: 'Abstract' }
    ])
  })

  it('keeps the id of an item whose title stays, so its chat stays with it', () => {
    const first = validateContents({ summary: '', items: [{ title: 'Attention', summary: '', sources: [] }] }, sources, null)
    const kept = { ...first, items: [{ ...first.items[0], id: 'kept-id' }] }
    const again = validateContents(
      {
        summary: '',
        items: [
          { title: 'Positional encoding', summary: '', sources: [] },
          { title: 'attention', summary: 'reworded', sources: [] }
        ]
      },
      sources,
      kept
    )
    expect(again.items.find((i) => i.title === 'attention')?.id).toBe('kept-id')
  })
})

describe('the plan of a quick course, checked by code', () => {
  const part = (title: string, minutes: number) => ({ title, covers: `What ${title} covers.`, minutes })

  it('makes the parts add up to the length the learner asked for', () => {
    const course = validateQuickPlan({ title: 'Hashing', summary: 'S', minutes: 90, sections: [part('Why', 10), part('How', 20), part('Use', 10)] }, 'teach me hashing', 20)!
    expect(course.minutes).toBe(20)
    expect(course.sections.map((s) => s.minutes)).toEqual([5, 10, 5])
    expect(course.sections.map((s) => s.id)).toEqual(['p1', 'p2', 'p3'])
    expect(course.status).toBe('writing')
    expect(course.sections.every((s) => s.body === undefined)).toBe(true)
  })

  it('bounds what a model may ask of one turn and of the reader', () => {
    // One part cannot be a three-hour read: it is cut to what one turn writes well.
    const long = validateQuickPlan({ title: 'T', summary: '', minutes: 180, sections: [part('Everything', 180)] }, 'x', null)!
    expect(long.minutes).toBe(25)
    const many = validateQuickPlan({ title: 'T', summary: '', minutes: 600, sections: Array.from({ length: 30 }, (_, i) => part(`Part ${i}`, 20)) }, 'x', null)!
    expect(many.sections).toHaveLength(14)
    expect(many.minutes).toBeLessThanOrEqual(240)
  })

  it('rejects a plan with nothing to write, and names an untitled one after the request', () => {
    expect(validateQuickPlan({ title: 'T', summary: '', minutes: 10, sections: [part('  ', 10)] }, 'x', null)).toBeNull()
    expect(validateQuickPlan({ title: ' ', summary: '', minutes: 10, sections: [part('Only part', 10)] }, 'How DNS works', null)!.title).toBe('How DNS works')
  })

  it('reads the length asked for, and stores a part without the heading mint shows itself', () => {
    expect(cleanMinutes(20)).toBe(20)
    expect(cleanMinutes(100_000)).toBe(240)
    expect(cleanMinutes(0)).toBeNull()
    expect(cleanMinutes('soon')).toBeNull()
    expect(cleanSectionBody('## Why it matters\n\nBecause.\n')).toBe('Because.')
    expect(cleanSectionBody('Because.\n\n### Later\n\nMore.')).toBe('Because.\n\n### Later\n\nMore.')
  })

  it('names times and streams the way the interface reads them', () => {
    expect([5, 60, 90, 180].map(readingTime)).toEqual(['5 min', '1 h', '1 h 30 min', '3 h'])
    expect(quickStreamSection('class_1', quickStreamId('class_1', 'p2'))).toBe('p2')
    expect(quickStreamSection('class_2', quickStreamId('class_1', 'p2'))).toBeNull()
  })
})

describe('a simple class', () => {
  let id = ''

  it('lists what is in the materials as soon as they are imported, with no intake and no plan', async () => {
    const folder = join(dir, 'Eigen paper')
    mkdirSync(folder)
    copyFileSync(join(root, 'tests/fixtures/e2e/eigen.md'), join(folder, 'eigen.md'))
    const meta = await core.handlers.classes.start({ paths: [folder], mode: 'simple' })
    id = meta.id
    expect(classMode(meta)).toBe('simple')
    const b = await until(async () => {
      const x = await bundle(id)
      return x.contents ? x : null
    })
    expect(b.contents!.items.length).toBeGreaterThan(0)
    expect(b.curriculum).toBeNull()
    // Every item points at a section the source really has.
    const doc = await core.handlers.sources.get(id, b.sources[0].id)
    const labels = new Set(doc.sections.map((s) => s.label))
    for (const item of b.contents!.items) for (const ref of item.sources) expect(labels.has(ref.section)).toBe(true)
    expect((await core.handlers.classes.list()).find((c) => c.id === id)?.mode).toBe('simple')
    await until(async () => existsSync(join(core.kernel.repo.dir(id), 'CONTENTS.md')))
  })

  it('answers the first message directly: no question cards', async () => {
    const t = await send(id, 'What is this about?')
    expect(t.messages.at(-1)?.role).toBe('tutor')
    expect(t.messages.some((m) => m.widget)).toBe(false)
    // Simple mode explains: it never starts on a lower rung of the help ladder.
    await core.handlers.settings.update({ tutorStyle: 'coach' })
    const coached = await send(id, 'And why does it matter?', { threadId: t.id })
    expect(coached.rung).toBe(4)
    await core.handlers.settings.update({ tutorStyle: 'teach' })
  })

  it('explains an item in a chat of its own, once', async () => {
    const item = (await bundle(id)).contents!.items[0]
    const first = await core.handlers.chat.command({ classId: id, command: 'explain', arg: item.id, streamId: 'explain-1' })
    expect(first.itemId).toBe(item.id)
    expect(first.title).toBe(item.title)
    expect(first.messages.map((m) => m.role)).toEqual(['user', 'tutor'])
    expect(first.messages[0].text).toBe(`Explain: ${item.title}`)
    expect(first.anchor).toMatchObject({ kind: 'general' })
    expect((first.anchor as { context?: string }).context).toContain(item.title)
    // Picking it again opens that chat; nothing is explained twice.
    const again = await core.handlers.chat.command({ classId: id, command: 'explain', arg: item.id, streamId: 'explain-2' })
    expect(again.id).toBe(first.id)
    expect(again.messages).toHaveLength(2)
    await expect(core.handlers.chat.command({ classId: id, command: 'explain', arg: 'no-such-item' })).rejects.toThrow(/no longer in the list/)
  })

  it('has no lessons or plan to run', async () => {
    await expect(core.handlers.chat.command({ classId: id, command: 'lesson' })).rejects.toThrow(/Simple mode/)
    await expect(core.handlers.chat.command({ classId: id, command: 'plan' })).rejects.toThrow(/Simple mode/)
  })

  it('tells every job what kind of class this is', async () => {
    const text = describeClass(await core.kernel.context(id))
    expect(text).toContain('Mode: Simple.')
    expect(text).toContain('## Contents')
    expect(text).toContain((await bundle(id)).contents!.items[0].title)
  })

  it('keeps its chats when the list is written again', async () => {
    const before = (await bundle(id)).contents!
    await core.handlers.contents.refresh(id)
    const after = (await bundle(id)).contents!
    expect(after.items.map((i) => i.id)).toEqual(before.items.map((i) => i.id))
    expect(after.updatedAt >= before.updatedAt).toBe(true)
  })

  it('can become a course and go back', async () => {
    const course = await core.handlers.classes.update(id, { mode: 'course' })
    expect(classMode(course)).toBe('course')
    // As a course it starts with the intake, like any course that has no plan yet.
    const intake = await send(id, 'I want to learn this properly')
    expect(intake.messages.at(-1)?.widget?.kind).toBe('questions')
    const simple = await core.handlers.classes.update(id, { mode: 'simple' })
    expect(classMode(simple)).toBe('simple')
    expect((await bundle(id)).contents).not.toBeNull()
    await expect(core.handlers.classes.update(id, { mode: 'quick' })).rejects.toThrow(/Course and Simple/)
  })

  it('has nothing to list once its material is gone', async () => {
    const b = await bundle(id)
    await core.handlers.sources.remove(id, b.sources[0].id)
    await until(async () => (await bundle(id)).contents === null)
    await expect(core.handlers.contents.refresh(id)).rejects.toThrow(/Add the material/)
  })
})

describe('a quick class', () => {
  let id = ''
  let threadId = ''

  it('starts empty: no materials, no intake', async () => {
    const meta = await core.handlers.classes.start({ mode: 'quick' })
    id = meta.id
    expect(classMode(meta)).toBe('quick')
    const b = await bundle(id)
    expect(b.quickCourse).toBeNull()
    expect(b.sources).toHaveLength(0)
  })

  it('writes a course of the length asked for from the first message', async () => {
    streams.length = 0
    const t = await send(id, 'Teach me binary search', { minutes: 20 })
    threadId = t.id
    expect(t.messages.map((m) => m.role)).toEqual(['user', 'tutor'])
    expect(t.messages[1].widget).toEqual({ kind: 'course' })
    const planned = (await bundle(id)).quickCourse!
    expect(planned.request).toBe('Teach me binary search')
    expect(planned.minutes).toBe(20)
    expect(planned.sections.length).toBeGreaterThan(1)
    // The class takes the course's name, and no trusted sources are looked for.
    expect((await bundle(id)).meta.title).toBe(planned.title)
    expect((await bundle(id)).sourceProposals).toHaveLength(0)

    const done = await until(async () => {
      const c = (await bundle(id)).quickCourse
      return c?.status === 'ready' ? c : null
    })
    expect(done.sections.every((s) => s.body && s.body.length > 40)).toBe(true)
    // Each part was streamed on its own stream, for the page that shows it being written.
    for (const s of done.sections) expect(streams.some((e) => e.streamId === quickStreamId(id, s.id) && e.delta)).toBe(true)
  })

  it('keeps the course as a file the tutor reads, and answers later messages as a tutor', async () => {
    const file = join(core.kernel.repo.dir(id), 'COURSE.md')
    await until(async () => existsSync(file) && readFileSync(file, 'utf8').includes('## 1.'))
    const text = describeClass(await core.kernel.context(id))
    expect(text).toContain('Mode: Quick course.')
    expect(text).toContain('never write a [[cite:...]] directive')
    expect(text).toContain(file)
    const t = await send(id, 'Why does it halve the range?', { threadId })
    expect(t.messages.at(-1)?.role).toBe('tutor')
    expect(t.messages.at(-1)?.widget).toBeUndefined()
    // Still one course: a later message never starts another.
    expect((await bundle(id)).quickCourse!.request).toBe('Teach me binary search')
  })

  it('has no lessons, and stays a quick course', async () => {
    await expect(core.handlers.chat.command({ classId: id, command: 'lesson' })).rejects.toThrow(/quick course has no lessons/)
    await expect(core.handlers.classes.update(id, { mode: 'simple' })).rejects.toThrow(/Course and Simple/)
  })

  it('shows a course that was cut off as stopped, and writes the rest on request', async () => {
    const repo = core.kernel.repo
    // As after a quit in the middle of the writing: marked as being written, with a part missing.
    await repo.lock(id, () =>
      repo.update(id, 'quickCourse', (c) => (c ? { ...c, status: 'writing' as const, sections: c.sections.map((s, i) => (i === c.sections.length - 1 ? { ...s, body: undefined } : s)) } : c))
    )
    const cut = (await bundle(id)).quickCourse!
    expect(cut.status).toBe('stopped')
    expect(cut.sections.at(-1)?.body).toBeUndefined()
    await core.handlers.quick.resume(id)
    const done = await until(async () => {
      const c = (await bundle(id)).quickCourse
      return c?.status === 'ready' ? c : null
    })
    expect(done.sections.every((s) => s.body)).toBe(true)
    // Stopping when nothing is being written changes nothing.
    await core.handlers.quick.stop(id)
    expect((await bundle(id)).quickCourse!.status).toBe('ready')
  })

  it('picks a length itself when none is asked for', async () => {
    const meta = await core.handlers.classes.start({ mode: 'quick' })
    await send(meta.id, 'How DNS works')
    const course = (await bundle(meta.id)).quickCourse!
    expect(course.minutes).toBeGreaterThan(0)
    // Deleting the class while its course is still being written leaves nothing behind.
    await core.handlers.classes.remove(meta.id)
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(core.kernel.repo.dir(meta.id))).toBe(false)
  })
})
