import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type MintCore } from '../../src/main/app'

/** A lesson on a subject that is done in code, with the offline Demo runtime. */
let dir: string
let core: MintCore

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mint-code-checks-'))
  const material = join(dir, 'zig.md')
  writeFileSync(
    material,
    [
      '# Functions in Zig',
      '',
      '## Writing a function in Zig',
      'A function in Zig is declared with fn, takes typed parameters and names its return type. A function that can fail returns an error union.',
      '',
      '## Calling a function in Zig',
      'A function call passes its arguments by value. The compiler may pass large values by reference when the function does not change them.'
    ].join('\n')
  )
  core = createCore({
    dataDir: join(dir, 'data'),
    cipher: { available: () => true, encrypt: (p) => `enc:${p}`, decrypt: (c) => c.slice(4) },
    emitter: { stream: () => undefined, progress: () => undefined, classChanged: () => undefined },
    host: { platform: 'darwin', pickFiles: async () => [material], openPath: async () => undefined, openExternal: async () => undefined }
  })
  await core.handlers.settings.update({ provider: 'demo' })
})

afterAll(async () => {
  await core.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('checks that ask for code', () => {
  it('remembers which check asks for code and in what language, and takes an answer written in it', async () => {
    const meta = await core.handlers.classes.create({
      title: 'Zig',
      mission: { topic: 'Zig', why: 'Write systems code.', successLooksLike: [], constraints: [], outOfScope: [] },
      intake: { timeline: '', timePerWeek: '', sessionLength: '', priorExperience: '', preferences: '', materialsMode: 'own' }
    })
    const classId = meta.id
    expect((await core.handlers.sources.addFiles(classId)).errors).toEqual([])
    await core.handlers.intake.proposeCurriculum(classId)
    let bundle = await core.handlers.classes.get(classId)
    await core.handlers.intake.resolveCurriculum(classId, bundle.curriculumProposals.find((p) => p.status === 'pending')!.id, true)
    bundle = await core.handlers.classes.get(classId)

    let s = await core.handlers.sessions.start(classId, bundle.nextTopicId!, 'learn')
    s = await core.handlers.sessions.setPhase(classId, s.id, 'explain')
    // Explaining is done in words; applying a function is done by writing one.
    expect(s.codeChecks).toBeUndefined()
    s = await core.handlers.sessions.setPhase(classId, s.id, 'apply')
    expect(s.codeChecks).toEqual({ apply: 'zig' })
    expect(s.prompts.apply).toMatch(/function/)
    // Going back and forth keeps it, and asks the tutor nothing new.
    s = await core.handlers.sessions.setPhase(classId, s.id, 'explain')
    s = await core.handlers.sessions.setPhase(classId, s.id, 'apply')
    expect(s.codeChecks).toEqual({ apply: 'zig' })

    const answer = '```zig\nfn add(a: i32, b: i32) i32 {\n    // Returns the sum of its two arguments, which the caller passes by value and the function never changes.\n    return a + b;\n}\n```'
    s = await core.handlers.sessions.submitCheck(classId, s.id, 'apply', answer)
    expect(s.attempts.at(-1)?.answer).toBe(answer)
    expect(s.attempts.at(-1)?.verdict?.result).toBe('pass')
    // The class as the renderer reads it carries the language, so the answer box opens as a code editor.
    const open = (await core.handlers.classes.get(classId)).sessions.find((x) => x.id === s.id)
    expect(open?.codeChecks).toEqual({ apply: 'zig' })
  })
})
