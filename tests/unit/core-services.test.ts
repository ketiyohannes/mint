import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCore, type MintCore } from '../../src/main/app'
import { createFixtureFetch } from '../../src/main/testing/fixtureFetch'
import type { Anchor, ProgressEvent, StreamEvent } from '@shared/types'
import { writeFileSync } from 'node:fs'

/**
 * Headless walk through every service with the offline Demo runtime: the same
 * code paths the app uses, minus Electron.
 */
const root = resolve(import.meta.dirname, '../..')
let dir: string
let core: MintCore
const streams: StreamEvent[] = []
const progress: ProgressEvent[] = []
const changed: string[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mint-core-'))
  const map = join(dir, 'fixtures.json')
  writeFileSync(map, JSON.stringify({ 'https://en.wikipedia.org/wiki/Linear_algebra': join(root, 'tests/fixtures/sources/article.html') }))
  core = createCore({
    dataDir: dir,
    cipher: { available: () => true, encrypt: (p) => `enc:${p}`, decrypt: (c) => c.slice(4) },
    fetchImpl: createFixtureFetch(map),
    emitter: { stream: (e) => streams.push(e), progress: (e) => progress.push(e), classChanged: (id) => changed.push(id) },
    host: { platform: 'darwin', pickFiles: async () => [join(root, 'tests/fixtures/e2e/eigen.md')], openPath: async () => undefined, openExternal: async () => undefined }
  })
  await core.handlers.settings.update({ provider: 'demo' })
})

afterAll(async () => {
  await core.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('mint core with the demo runtime', () => {
  let classId = ''
  let topicId = ''

  it('stores settings and encrypted secrets', async () => {
    const view = await core.handlers.settings.setSecret('openai', 'sk-test')
    expect(view.hasOpenAIKey).toBe(true)
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toContain('enc:sk-test')
    expect((await core.handlers.settings.testProvider('demo')).ok).toBe(true)
    await expect(core.handlers.settings.update({ provider: 'bogus' as never })).resolves.toMatchObject({ provider: 'claude' })
    await core.handlers.settings.update({ provider: 'demo' })
  })

  it('lists models per harness and remembers each provider\'s model', async () => {
    expect(await core.handlers.settings.models('demo')).toEqual({ models: [] })
    await expect(core.handlers.settings.models('bogus' as never)).rejects.toThrow(/Unknown provider/)
    const view = await core.handlers.settings.update({ claudeModel: 'sonnet', codexModel: 'gpt-x' })
    expect(view).toMatchObject({ provider: 'demo', claudeModel: 'sonnet', codexModel: 'gpt-x' })
    await core.handlers.settings.update({ claudeModel: '', codexModel: '' })
  })

  it('runs intake: class, materials, diagnostic, curriculum approval', async () => {
    await expect(core.handlers.classes.create({ title: ' ', mission: { topic: '', why: '', successLooksLike: [], constraints: [], outOfScope: [] }, intake: {} as never })).rejects.toThrow(/name or a topic/)
    const meta = await core.handlers.classes.create({
      title: 'Linear algebra',
      mission: { topic: 'Linear algebra', why: 'Read ML papers.', successLooksLike: ['Explain eigenvectors'], constraints: [], outOfScope: ['proofs'] },
      intake: { timeline: '6 weeks', timePerWeek: '3h', sessionLength: '30 minutes', priorExperience: '', preferences: '', materialsMode: 'mixed' }
    })
    classId = meta.id
    expect(meta.stage).toBe('intake')

    await expect(core.handlers.intake.proposeCurriculum(classId)).rejects.toThrow(/source/)
    const { added, errors } = await core.handlers.sources.addFiles(classId)
    expect(errors).toEqual([])
    expect(added[0].title).toContain('Eigenvectors')
    const bad = await core.handlers.sources.addFiles(classId, [join(dir, 'nope.xyz')])
    expect(bad.errors[0]).toMatch(/nope\.xyz/)

    await core.handlers.intake.startDiagnostic(classId)
    let bundle = await core.handlers.classes.get(classId)
    expect(bundle.diagnostic?.questions.length).toBeGreaterThan(1)
    await core.handlers.intake.submitDiagnostic(classId, ['I used matrices for 3D graphics in a game engine for two years.', "I don't know"])
    bundle = await core.handlers.classes.get(classId)
    expect(bundle.diagnostic?.result?.startingLevel).toBeTruthy()
    expect(bundle.records[0]?.kind).toBe('prior-knowledge')

    await core.handlers.intake.proposeCurriculum(classId)
    bundle = await core.handlers.classes.get(classId)
    const proposal = bundle.curriculumProposals.find((p) => p.status === 'pending')!
    expect(proposal.curriculum.milestones.length).toBeGreaterThan(0)
    await core.handlers.intake.resolveCurriculum(classId, proposal.id, true)
    await expect(core.handlers.intake.resolveCurriculum(classId, proposal.id, true)).rejects.toThrow(/no longer pending/)
    bundle = await core.handlers.classes.get(classId)
    expect(bundle.meta.stage).toBe('active')
    expect(bundle.nextTopicId).toBeTruthy()
    topicId = bundle.nextTopicId!
    // Every topic reading points at a real source and section.
    const doc = await core.handlers.sources.get(classId, added[0].id)
    for (const t of bundle.curriculum!.milestones.flatMap((m) => m.topics)) {
      for (const r of t.sources) expect(doc.sections.map((s) => s.label)).toContain(r.section)
    }
  })

  it('answers Ask threads on the help ladder and logs help for independence', async () => {
    const bundle = await core.handlers.classes.get(classId)
    const doc = await core.handlers.sources.get(classId, bundle.sources[0].id)
    const block = doc.sections[0].blocks[1] ?? doc.sections[0].blocks[0]
    const anchor: Anchor = { kind: 'source', sourceId: doc.id, sectionLabel: doc.sections[0].label, ranges: [{ blockId: block.id, start: 0, end: 20 }], quote: block.text.slice(0, 20) }
    const t = await core.handlers.threads.create({ classId, anchor, message: 'Why?', via: 'text', streamId: 's1' })
    expect(t.rung).toBe(3) // new learners start at a hint
    expect(t.messages.at(-1)?.role).toBe('tutor')
    expect(t.messages.at(-1)?.text).toContain(`[[cite:${doc.id}|`)
    expect(streams.some((e) => e.streamId === 's1' && e.delta)).toBe(true)
    expect(streams.some((e) => e.streamId === 's1' && e.done)).toBe(true)

    const t2 = await core.handlers.threads.moreHelp({ classId, threadId: t.id, streamId: 's2' })
    expect(t2.rung).toBe(4)
    await expect(core.handlers.threads.moreHelp({ classId, threadId: t.id, streamId: 's3' })).rejects.toThrow(/already the full explanation/)

    // Follow-up on a reply, then a follow-up on that follow-up stays in the same thread (nesting cap).
    const reply = t2.messages.at(-1)!
    const f1 = await core.handlers.threads.create({ classId, anchor: { kind: 'message', threadId: t.id, messageId: reply.id, quote: 'full explanation' }, message: 'More?', via: 'text', streamId: 's4' })
    const f2 = await core.handlers.threads.create({ classId, anchor: { kind: 'message', threadId: f1.id, messageId: f1.messages.at(-1)!.id, quote: 'x' }, message: 'And?', via: 'text', streamId: 's5' })
    expect(f2.id).toBe(f1.id)

    await expect(core.handlers.threads.create({ classId, anchor: { ...anchor, ranges: [{ blockId: 'nope', start: 0, end: 3 }] } as Anchor, message: 'x', via: 'text', streamId: 's6' })).rejects.toThrow(/located/)
    const after = await core.handlers.classes.get(classId)
    expect(after.helpEvents.filter((e) => e.escalated)).toHaveLength(1)
    expect(after.independence.asks).toBeGreaterThan(0)

    await core.handlers.threads.setPinned(classId, t.id, true)
    const note = await core.handlers.notes.fromThread(classId, t.id)
    expect(note.body).toContain('## In my own words')
  })

  it('runs the session loop to mastery with records, terms and a spaced review', async () => {
    let s = await core.handlers.sessions.start(classId, topicId, 'learn')
    expect(s.brief?.questions.length).toBeGreaterThan(0)
    expect((await core.handlers.sessions.start(classId, topicId, 'learn')).id).toBe(s.id) // resumes
    const answer = 'An eigenvector keeps its direction under the matrix and is only scaled by it; the scale factor is the eigenvalue, so A times x equals lambda times x for that special vector.'
    for (const phase of ['explain', 'apply', 'distinguish'] as const) {
      s = await core.handlers.sessions.setPhase(classId, s.id, phase)
      expect(s.prompts[phase]).toBeTruthy()
      s = await core.handlers.sessions.submitCheck(classId, s.id, phase, 'idk', 'text')
      expect(s.attempts.at(-1)?.verdict?.result).toBe('fail')
      s = await core.handlers.sessions.submitCheck(classId, s.id, phase, answer, 'voice')
      expect(s.attempts.at(-1)?.verdict?.result).toBe('pass')
    }
    await expect(core.handlers.sessions.submitCheck(classId, s.id, 'explain', '   ', 'text')).rejects.toThrow(/answer first/)
    s = await core.handlers.sessions.setPhase(classId, s.id, 'wrap')
    expect(s.wrap?.records.length).toBeGreaterThan(0)
    s = await core.handlers.sessions.finish(classId, s.id, [0], [0])
    expect(s.endedAt).toBeTruthy()
    const bundle = await core.handlers.classes.get(classId)
    expect(bundle.progress[topicId].status).toBe('mastered')
    expect(bundle.progress[topicId].nextReviewAt).toBeTruthy()
    expect(bundle.records.some((r) => r.sessionId === s.id)).toBe(true)
    expect(bundle.glossary.length).toBe(1)
    expect(bundle.nextTopicId).not.toBe(topicId)
  })

  it('checks learner-written glossary terms and supersedes records', async () => {
    const no = await core.handlers.glossary.propose(classId, 'Eigenspace', 'a space')
    expect(no.accepted).toBe(false)
    const yes = await core.handlers.glossary.propose(classId, 'Eigenspace', 'All the eigenvectors for one eigenvalue, plus zero, forming a subspace.')
    expect(yes.accepted).toBe(true)
    await expect(core.handlers.glossary.propose(classId, 'eigenspace', 'dup definition with enough words here')).rejects.toThrow(/already/)
    const bundle = await core.handlers.classes.get(classId)
    await core.handlers.records.supersede(classId, bundle.records[0].id, 'Corrected', 'Actually knows less than claimed.')
    const after = await core.handlers.classes.get(classId)
    expect(after.records[0].supersededBy).toBeTruthy()
    await expect(core.handlers.records.supersede(classId, after.records[0].id, 'x', 'y')).rejects.toThrow(/already superseded/)
  })

  it('builds, repairs (bounded) and keeps diagrams', async () => {
    const e = await core.handlers.diagrams.create(classId, 'vectors under a matrix')
    expect(e.spec.engine).toBe('p5')
    expect(e.spec.elements.map((x) => x.id)).toContain('vector')
    const r1 = await core.handlers.diagrams.repair(classId, e.id, 'ReferenceError: foo')
    const r2 = await core.handlers.diagrams.repair(classId, e.id, 'ReferenceError: foo')
    expect(r2.repairs).toBe(2)
    expect(r1.id).toBe(e.id)
    await expect(core.handlers.diagrams.repair(classId, e.id, 'again')).rejects.toThrow(/two repairs/)
    await core.handlers.diagrams.setKept(classId, e.id, true)
    const thread = await core.handlers.threads.create({ classId, anchor: { kind: 'diagram', explorableId: e.id, elementId: 'vector', label: 'Vector' }, message: 'What is this?', via: 'voice', streamId: 'd1', voice: true })
    expect(thread.messages.at(-1)?.text).toContain('[[highlight:vector]]')
  })

  it('notes, reference drafts and reviews follow the fading rule', async () => {
    const n = await core.handlers.notes.save(classId, { kind: 'note', title: 'Mine', body: 'Eigenvectors are directions a matrix only scales.' })
    const review = await core.handlers.notes.review(classId, n.id, 'r1')
    expect(review.length).toBeGreaterThan(10)
    const level = (await core.handlers.classes.get(classId)).independence.level
    if (level >= 2) {
      // Authorship fades: an independent learner writes reference sheets themselves.
      await expect(core.handlers.notes.draftReference(classId, topicId)).rejects.toThrow(/write reference sheets yourself/)
    } else {
      const draft = await core.handlers.notes.draftReference(classId, topicId)
      expect(draft.authoredBy).toBe('tutor-draft')
      const edited = await core.handlers.notes.save(classId, { id: draft.id, kind: 'reference', title: draft.title, body: `${draft.body}\nMy edit.` })
      expect(edited.authoredBy).toBe('learner')
    }
    // A learner-written sheet can always be reviewed.
    const sheet = await core.handlers.notes.save(classId, { kind: 'reference', title: 'My sheet', body: 'Eigen: directions a matrix only scales, by the eigenvalue.' })
    expect(sheet.authoredBy).toBe('learner')
  })

  it('imports approved trusted sources only from allowlisted domains', async () => {
    await core.handlers.sources.proposeTrusted(classId)
    let bundle = await core.handlers.classes.get(classId)
    const wiki = bundle.sourceProposals.find((p) => p.domain === 'en.wikipedia.org')!
    expect(wiki.newDomain).toBe(false)
    const other = bundle.sourceProposals.find((p) => p.id !== wiki.id)!
    await core.handlers.sources.resolveProposals(classId, [wiki.id], [other.id])
    bundle = await core.handlers.classes.get(classId)
    const imported = bundle.sourceProposals.find((p) => p.id === wiki.id)!
    expect(imported.status).toBe('imported')
    expect(bundle.sources.find((s) => s.id === imported.sourceId)?.origin).toBe('trusted')
    expect(bundle.sourceProposals.find((p) => p.id === other.id)?.status).toBe('rejected')
  })

  it('writes a /teach-style workspace folder', async () => {
    await core.kernel.writeExports(classId)
    const cdir = join(dir, 'classes', classId)
    for (const f of ['MISSION.md', 'CURRICULUM.md', 'RESOURCES.md', 'GLOSSARY.md']) expect(existsSync(join(cdir, f))).toBe(true)
    expect(readFileSync(join(cdir, 'MISSION.md'), 'utf8')).toContain('## Out of scope\n- proofs')
    expect(readdirSync(join(cdir, 'learning-records')).some((f) => /^0001-/.test(f))).toBe(true)
    expect(readFileSync(join(cdir, 'GLOSSARY.md'), 'utf8')).toContain('**Eigenspace**')
    const bundle = await core.handlers.classes.get(classId)
    const content = readFileSync(join(cdir, 'sources', bundle.sources[0].id, 'content.md'), 'utf8')
    expect(content).toMatch(/\^s0b\d+/)
    expect(progress.some((p) => p.state === 'done')).toBe(true)
    expect(changed).toContain(classId)
  })

  it('removes sources and classes cleanly', async () => {
    const bundle = await core.handlers.classes.get(classId)
    const trusted = bundle.sources.find((s) => s.origin === 'trusted')!
    await core.handlers.sources.remove(classId, trusted.id)
    expect((await core.handlers.classes.get(classId)).sources.some((s) => s.id === trusted.id)).toBe(false)
    expect((await core.handlers.classes.list()).length).toBe(1)
    // Delete while a markdown export is due and another is mid-write: the folder must still go.
    core.kernel.changed(classId)
    const racing = core.kernel.writeExports(classId)
    await core.handlers.classes.remove(classId)
    await racing
    await new Promise((r) => setTimeout(r, 600))
    expect(existsSync(join(dir, 'classes', classId))).toBe(false)
    await expect(core.handlers.classes.get(classId)).rejects.toThrow(/no longer exists/)
    expect(await core.handlers.classes.list()).toEqual([])
  })
})
