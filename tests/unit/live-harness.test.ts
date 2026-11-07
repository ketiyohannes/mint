import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCore, type MintCore } from '../../src/main/app'
import { extractDirectives } from '@shared/directives'
import type { Anchor, ProviderId } from '@shared/types'

/**
 * Live end-to-end run of mint's real jobs against a real harness.
 * Skipped unless MINT_LIVE=claude or MINT_LIVE=codex (costs model usage).
 */
const provider = process.env.MINT_LIVE as ProviderId | undefined
const root = resolve(import.meta.dirname, '../..')

describe.skipIf(provider !== 'claude' && provider !== 'codex')(`live harness: ${provider}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-live-'))
  const deltas: string[] = []
  const core: MintCore = createCore({
    dataDir: dir,
    cipher: { available: () => true, encrypt: (p) => p, decrypt: (c) => c },
    emitter: { stream: (e) => e.delta && deltas.push(e.delta), progress: () => undefined, classChanged: () => undefined },
    host: { platform: 'darwin', pickFiles: async () => [join(root, 'tests/fixtures/e2e/eigen.md')], openPath: async () => undefined, openExternal: async () => undefined },
    log: (m) => console.log(m)
  })
  let classId = ''

  afterAll(async () => {
    await core.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('connects', async () => {
    await core.handlers.settings.update({ provider })
    const check = await core.handlers.settings.testProvider(provider!)
    console.log('check:', check)
    expect(check.ok).toBe(true)
  }, 60_000)

  it('plans a valid curriculum from the materials', async () => {
    const meta = await core.handlers.classes.create({
      title: 'Eigen',
      mission: { topic: 'Eigenvectors', why: 'Understand PCA well enough to implement it.', successLooksLike: ['Explain eigenvectors'], constraints: [], outOfScope: [] },
      intake: { timeline: '2 weeks', timePerWeek: '2 hours', sessionLength: '30 minutes', priorExperience: 'Some matrix multiplication.', preferences: '', materialsMode: 'own' }
    })
    classId = meta.id
    await core.handlers.sources.addFiles(classId)
    await core.handlers.intake.skipDiagnostic(classId)
    await core.handlers.intake.proposeCurriculum(classId)
    const b = await core.handlers.classes.get(classId)
    const p = b.curriculumProposals[0]
    console.log('curriculum:', JSON.stringify(p.curriculum.milestones.map((m) => [m.title, m.topics.map((t) => `${t.title} @ ${t.sources.map((s) => s.section).join(',')}`)])), 'repairs:', p.repairs)
    expect(p.curriculum.milestones.length).toBeGreaterThan(0)
    await core.handlers.intake.resolveCurriculum(classId, p.id, true)
  }, 600_000)

  it('writes a session brief and judges an answer', async () => {
    const b = await core.handlers.classes.get(classId)
    const s = await core.handlers.sessions.start(classId, b.nextTopicId!, 'learn')
    console.log('brief:', JSON.stringify(s.brief))
    expect(s.brief?.questions.length).toBeGreaterThan(0)
    const s2 = await core.handlers.sessions.setPhase(classId, s.id, 'apply')
    console.log('apply prompt:', s2.prompts.apply)
    const s3 = await core.handlers.sessions.submitCheck(classId, s.id, 'apply', 'I do not know.')
    console.log('verdict:', JSON.stringify(s3.attempts.at(-1)?.verdict))
    expect(s3.attempts.at(-1)?.verdict?.result).toBe('fail')
  }, 600_000)

  it('answers an Ask with a full explanation and a citation that resolves', async () => {
    const b = await core.handlers.classes.get(classId)
    const doc = await core.handlers.sources.get(classId, b.sources[0].id)
    const block = doc.sections.flatMap((s) => s.blocks).find((x) => x.text.includes('stay on the same line'))!
    const section = doc.sections.find((s) => s.blocks.includes(block))!
    const start = block.text.indexOf('stay on the same line')
    const anchor: Anchor = { kind: 'source', sourceId: doc.id, sectionLabel: section.label, ranges: [{ blockId: block.id, start, end: start + 40 }], quote: block.text.slice(start, start + 40) }
    const t = await core.handlers.threads.create({ classId, anchor, message: 'Why do these vectors not change direction?', streamId: 'live1' })
    const reply = t.messages.at(-1)!
    console.log(`rung ${reply.rung}:`, reply.text)
    expect(reply.error).toBeFalsy()
    expect(deltas.length).toBeGreaterThan(0)
    const cites = extractDirectives(reply.text).filter((d) => d.type === 'cite')
    expect(cites.length).toBeGreaterThan(0)
    for (const c of cites) if (c.type === 'cite') expect(c.sourceId).toBe(doc.id)
  }, 600_000)

  it('asks intake questions, then writes a quiz and a Python exercise with tests', async () => {
    // A fresh class: the first message gets multiple-choice intake questions.
    const fresh = await core.handlers.classes.start({ paths: [join(root, 'tests/fixtures/e2e/eigen.md')] })
    for (let i = 0; i < 100 && !(await core.handlers.classes.get(fresh.id)).sources.length; i++) await new Promise((r) => setTimeout(r, 100))
    const asked = await core.handlers.chat.send({ classId: fresh.id, message: 'Teach me this so I can use it for PCA', streamId: 'live-q' })
    const qwidget = asked.messages.at(-1)!.widget
    console.log('questions:', JSON.stringify(asked.messages.at(-1)))
    expect(qwidget?.kind).toBe('questions')
    if (qwidget?.kind === 'questions') {
      expect(qwidget.questions.length).toBeGreaterThanOrEqual(2)
      expect(qwidget.questions.every((q) => q.options.length >= 2 && q.header.length <= 12)).toBe(true)
    }

    const intro = await core.handlers.chat.send({ classId, message: 'I want to get comfortable with eigenvectors for PCA', streamId: 'live-intake' })
    const w = intro.messages.at(-1)!.widget
    console.log('intake:', JSON.stringify(intro.messages.at(-1)))
    // This class finished intake earlier, so the message goes to the tutor instead.
    expect(intro.messages.at(-1)!.role).toBe('tutor')
    expect(w).toBeUndefined()

    const quiz = await core.handlers.chat.command({ classId, threadId: intro.id, command: 'quiz', arg: 'eigenvalues' })
    const qw = quiz.messages.at(-1)!.widget
    console.log('quiz:', JSON.stringify(qw))
    expect(qw?.kind).toBe('quiz')
    if (qw?.kind === 'quiz') expect(qw.questions.every((q) => q.options.length >= 2 && q.answer >= 0 && q.answer < q.options.length)).toBe(true)

    const code = await core.handlers.chat.command({ classId, threadId: intro.id, command: 'code', arg: 'python' })
    const cw = code.messages.at(-1)!.widget
    console.log('exercise:', JSON.stringify(cw))
    expect(cw).toMatchObject({ kind: 'code', exercise: { language: 'python' } })
    if (cw?.kind === 'code') expect(cw.exercise.tests).toMatch(/def test_/)
  }, 600_000)

  it('builds a diagram that follows the sketch contract', async () => {
    const e = await core.handlers.diagrams.create(classId, 'Show how a 2x2 matrix moves a vector, and that eigenvectors only stretch')
    console.log('diagram:', e.spec.engine, e.spec.title, e.spec.elements.map((x) => x.id), e.spec.params)
    expect(e.spec.code).toMatch(/mint\.(region|object)\(/)
    expect(e.spec.elements.length).toBeGreaterThan(1)
  }, 600_000)
})
