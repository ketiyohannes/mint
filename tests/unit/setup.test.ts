import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCore, type MintCore } from '../../src/main/app'
import { createFixtureFetch } from '../../src/main/testing/fixtureFetch'
import { expandPaths, titleFromPaths } from '../../src/main/sources/expand'
import type { ProgressEvent } from '@shared/types'

/** Project-style class creation: name + materials, then import and planning in the background. */
const root = resolve(import.meta.dirname, '../..')
let dir: string
let core: MintCore
const progress: ProgressEvent[] = []

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mint-setup-'))
  const map = join(dir, 'fixtures.json')
  writeFileSync(map, JSON.stringify({ 'https://en.wikipedia.org/wiki/Linear_algebra': join(root, 'tests/fixtures/sources/article.html') }))
  core = createCore({
    dataDir: join(dir, 'data'),
    cipher: { available: () => true, encrypt: (p) => p, decrypt: (c) => c },
    fetchImpl: createFixtureFetch(map),
    emitter: { stream: () => undefined, progress: (e) => progress.push(e), classChanged: () => undefined },
    host: { platform: 'darwin', pickFiles: async () => [], openPath: async () => undefined, openExternal: async () => undefined }
  })
  await core.handlers.settings.update({ provider: 'demo' })
})

afterAll(async () => {
  await core.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('folder expansion', () => {
  it('walks a folder like a project: readable files only, natural order, no hidden or build folders', async () => {
    const f = join(dir, 'Linear Algebra')
    mkdirSync(join(f, 'chapters'), { recursive: true })
    mkdirSync(join(f, '.git'))
    mkdirSync(join(f, 'node_modules'))
    writeFileSync(join(f, 'chapters', 'ch10.md'), '# Ten')
    writeFileSync(join(f, 'chapters', 'ch2.md'), '# Two')
    writeFileSync(join(f, 'notes.txt'), 'notes')
    writeFileSync(join(f, 'image.png'), 'x')
    writeFileSync(join(f, '.hidden.md'), 'x')
    writeFileSync(join(f, '.git', 'HEAD.md'), 'x')
    writeFileSync(join(f, 'node_modules', 'readme.md'), 'x')
    const { files, truncated } = await expandPaths([f])
    expect(files.map((p) => p.slice(f.length + 1).replaceAll('\\', '/'))).toEqual(['chapters/ch2.md', 'chapters/ch10.md', 'notes.txt'])
    expect(truncated).toBe(false)
    expect(await titleFromPaths([f])).toBe('Linear Algebra')
    expect(await titleFromPaths([join(f, 'chapters', 'ch2.md')])).toBe('ch2')
  })

  it('keeps explicitly picked files so unsupported ones still report an error', async () => {
    const png = join(dir, 'Linear Algebra', 'image.png')
    expect((await expandPaths([png])).files).toEqual([png])
  })
})

describe('classes.start + the chat intake', () => {
  const send = (classId: string, message: string, threadId?: string) => core.handlers.chat.send({ classId, threadId, message, streamId: `s${Math.random()}` })
  const bundle = (id: string) => core.handlers.classes.get(id)
  let eigenId = ''

  it('creates the class at once from a folder and imports in the background, without planning yet', async () => {
    const f = join(dir, 'Eigen')
    mkdirSync(f)
    copyFileSync(join(root, 'tests/fixtures/e2e/eigen.pdf'), join(f, 'eigen.pdf'))
    const meta = await core.handlers.classes.start({ paths: [f] })
    eigenId = meta.id
    expect(meta.title).toBe('Eigen')
    expect(meta.stage).toBe('intake')
    const b = await until(async () => {
      const x = await bundle(meta.id)
      return x.sources.length ? x : null
    })
    await new Promise((r) => setTimeout(r, 150))
    expect((await bundle(meta.id)).curriculum).toBeNull()
    // The page view gets the original PDF bytes.
    const bytes = await core.handlers.sources.original(meta.id, b.sources[0].id)
    expect(Buffer.from(bytes!).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('answers the first message with multiple-choice questions, then plans from the answers', async () => {
    const t1 = await send(eigenId, 'I want to understand eigenvectors for ML')
    const q = t1.messages.at(-1)!
    expect(t1.messages[0]).toMatchObject({ role: 'user', text: 'I want to understand eigenvectors for ML' })
    expect(q.widget?.kind).toBe('questions')
    const questions = q.widget?.kind === 'questions' ? q.widget.questions : []
    expect(questions.length).toBeGreaterThanOrEqual(2)
    expect(questions.every((x) => x.header.length <= 12 && x.options.length >= 2)).toBe(true)
    expect((await bundle(eigenId)).meta.title).toBe('Eigen') // a folder name is kept

    const [goal, background, style] = questions
    const t2 = await core.handlers.chat.answer({
      classId: eigenId,
      threadId: t1.id,
      messageId: q.id,
      answer: { kind: 'questions', answers: { [goal.id]: [goal.options[0].label], [background.id]: [background.options[1].label, 'ignored second pick'], [style.id]: [style.options[1].label, style.options[2].label], bogus: ['x'] } }
    })
    const answered = t2.messages.find((m) => m.id === q.id)!.widget
    expect(answered).toMatchObject({ kind: 'questions', answers: { [goal.id]: [goal.options[0].label], [background.id]: [background.options[1].label] } })
    expect(Object.keys(answered?.kind === 'questions' ? answered.answers! : {})).not.toContain('bogus')
    await expect(core.handlers.chat.answer({ classId: eigenId, threadId: t1.id, messageId: q.id, answer: { kind: 'questions', skip: true } })).rejects.toThrow(/already answered/)

    const planned = await until(async () => {
      const x = await bundle(eigenId)
      return x.curriculum && x.meta.stage === 'active' && x.threads.find((t) => t.id === t1.id)?.messages.some((m) => m.widget?.kind === 'plan') ? x : null
    })
    expect(planned.meta.mission.why).toContain('eigenvectors for ML')
    expect(planned.meta.intake.priorExperience).toBe(background.options[1].label)
    expect(planned.meta.intake.preferences).toContain(style.options[2].label)
    expect(planned.diagnostic?.result?.startingLevel).toBe(background.options[1].label)
  })

  it('after the intake, messages go to the tutor with the help ladder', async () => {
    const t = await send(eigenId, 'What is an eigenvalue?')
    expect(t.anchor.kind).toBe('general')
    expect(t.messages.at(-1)).toMatchObject({ role: 'tutor' })
    expect(t.messages.at(-1)!.rung).toBeGreaterThanOrEqual(1)
  })

  it('runs tools as widgets: quiz, code exercise, diagram, lesson and re-plan', async () => {
    const quiz = await core.handlers.chat.command({ classId: eigenId, command: 'quiz', arg: 'eigenvalues' })
    expect(quiz.messages[0]).toMatchObject({ role: 'user', text: '/quiz eigenvalues' })
    const qm = quiz.messages.at(-1)!
    expect(qm.widget?.kind).toBe('quiz')
    const n = qm.widget?.kind === 'quiz' ? qm.widget.questions.length : 0
    const graded = await core.handlers.chat.answer({ classId: eigenId, threadId: quiz.id, messageId: qm.id, answer: { kind: 'quiz', choices: [1, 99, 0] } })
    expect(graded.messages.at(-1)!.widget).toMatchObject({ kind: 'quiz', choices: [1, -1, 0].slice(0, n) })
    await expect(core.handlers.chat.answer({ classId: eigenId, threadId: quiz.id, messageId: qm.id, answer: { kind: 'quiz', choices: [0] } })).rejects.toThrow(/already answered/)
    await expect(core.handlers.chat.answer({ classId: eigenId, threadId: quiz.id, messageId: qm.id, answer: { kind: 'questions', skip: true } })).rejects.toThrow(/does not fit/)

    const code = await core.handlers.chat.command({ classId: eigenId, threadId: quiz.id, command: 'code', arg: 'python please' })
    const cm = code.messages.at(-1)!
    expect(cm.widget).toMatchObject({ kind: 'code', exercise: { language: 'python' } })
    const reviewed = await core.handlers.chat.answer({
      classId: eigenId,
      threadId: quiz.id,
      messageId: cm.id,
      answer: { kind: 'code', code: 'def scale(v, k):\n    return [x * k for x in v]', result: { ok: true, output: [], tests: [{ name: 'test_basic', pass: true }, { name: 'test_negative', pass: true }] }, streamId: 'code1' }
    })
    expect(reviewed.messages.find((m) => m.id === cm.id)!.widget).toMatchObject({ kind: 'code', submission: { passed: 2, total: 2 } })
    expect(reviewed.messages.at(-1)).toMatchObject({ role: 'tutor' })
    expect(reviewed.messages.at(-1)!.text).toMatch(/2 tests pass/)

    const diagram = await core.handlers.chat.command({ classId: eigenId, threadId: quiz.id, command: 'diagram', arg: 'a matrix stretching a vector' })
    const dm = diagram.messages.at(-1)!
    expect(dm.widget?.kind).toBe('diagram')
    expect((await bundle(eigenId)).explorables.some((e) => dm.widget?.kind === 'diagram' && e.id === dm.widget.explorableId)).toBe(true)

    const lesson = await core.handlers.chat.command({ classId: eigenId, command: 'lesson' })
    expect(lesson.id).not.toBe(quiz.id)
    expect(lesson.title).toMatch(/^Lesson: /)
    expect(lesson.sessionId).toBeTruthy()
    expect(lesson.messages[0].widget).toMatchObject({ kind: 'lesson', sessionId: lesson.sessionId })

    const before = (await bundle(eigenId)).curriculum!.version
    const plan = await core.handlers.chat.command({ classId: eigenId, threadId: quiz.id, command: 'plan', arg: 'More practice on the defining equation.' })
    expect(plan.messages.at(-1)!.widget?.kind).toBe('plan')
    const after = await bundle(eigenId)
    expect(after.curriculum!.version).toBeGreaterThan(before)
    expect(after.curriculumProposals.at(-1)).toMatchObject({ status: 'accepted', reason: 'More practice on the defining equation.' })

    await expect(core.handlers.chat.command({ classId: eigenId, command: 'bogus' as never })).rejects.toThrow(/Unknown command/)
    await expect(send(eigenId, '   ')).rejects.toThrow(/message first/)
  })

  it('typing instead of picking answers the open questions in the learner’s own words', async () => {
    const meta = await core.handlers.classes.start({ title: 'Typed', paths: [join(root, 'tests/fixtures/e2e/eigen.md')] })
    await until(async () => ((await bundle(meta.id)).sources.length ? true : null))
    const t = await send(meta.id, 'Teach me this')
    expect(t.messages.at(-1)!.widget?.kind).toBe('questions')
    const t2 = await send(meta.id, 'I have an exam in two weeks and know nothing yet', t.id)
    expect(t2.messages.some((m) => m.role === 'user' && m.text === 'I have an exam in two weeks and know nothing yet')).toBe(true)
    const done = await until(async () => {
      const x = await bundle(meta.id)
      return x.curriculum && x.meta.stage === 'active' ? x : null
    })
    expect(done.meta.mission.why).toContain('exam in two weeks')
    expect(done.meta.intake.preferences).toContain('In their words')
  })

  it('without materials it names the class, proposes trusted sources in the chat, and plans once one is approved', async () => {
    const meta = await core.handlers.classes.start({})
    expect(meta.title).toBe('New class')
    expect(meta.intake.materialsMode).toBe('trusted')
    const t = await send(meta.id, 'I want to learn linear algebra')
    expect((await bundle(meta.id)).meta.title).toBe('Linear algebra')
    const q = t.messages.at(-1)!
    await core.handlers.chat.answer({ classId: meta.id, threadId: t.id, messageId: q.id, answer: { kind: 'questions', skip: true } })
    const withProposals = await until(async () => {
      const x = await bundle(meta.id)

      return x.threads.find((y) => y.id === t.id)?.messages.some((m) => m.widget?.kind === 'sources') ? x : null
    })
    const wiki = withProposals.sourceProposals.find((p) => p.url.includes('wikipedia'))!
    await core.handlers.sources.resolveProposals(meta.id, [wiki.id], [])
    const planned = await until(async () => {
      const x = await bundle(meta.id)
      return x.curriculum && x.threads.find((y) => y.id === t.id)?.messages.some((m) => m.widget?.kind === 'plan') ? x : null
    })
    expect(planned.sources[0].origin).toBe('trusted')
  })

  it('validates input and reports background import failures as notices', async () => {
    await expect(core.handlers.classes.start({ title: 'x', urls: ['ftp://nope'] })).rejects.toThrow(/http/)
    const meta = await core.handlers.classes.start({ title: 'Broken', paths: [join(dir, 'missing.pdf')] })
    await until(async () => progress.find((p) => p.classId === meta.id && p.notice))
  })

  it('does not re-plan a planned class when more materials arrive', async () => {
    const before = (await bundle(eigenId)).curriculum!.version
    await core.handlers.sources.addFiles(eigenId, [join(root, 'tests/fixtures/e2e/eigen.md')])
    await new Promise((r) => setTimeout(r, 200))
    expect((await bundle(eigenId)).curriculum!.version).toBe(before)
  })
})
