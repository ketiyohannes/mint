import { describe, expect, it } from 'vitest'
import type { AgentRuntime, AgentTurnRequest } from '../../src/main/agents/types'
import type { ClassContext } from '../../src/main/jobs/context'
import { intakeQuestions, makeQuiz, tutorReply } from '../../src/main/jobs'
import { parseSections, teach, TEACH_SECTIONS } from '../../src/main/pedagogy/teach'

/** Runs every turn on its demo answer and keeps the requests for inspection. */
function capturingRuntime(): AgentRuntime & { requests: AgentTurnRequest[] } {
  const requests: AgentTurnRequest[] = []
  return {
    id: 'demo',
    requests,
    async run(req) {
      requests.push(req)
      const answer = (await req.demo?.()) ?? {}
      return { text: answer.text ?? JSON.stringify(answer.structured ?? null), structured: answer.structured }
    },
    async check() {
      return { ok: true, message: 'ok' }
    },
    async listModels() {
      return []
    },
    async dispose() {}
  }
}

const ctx: ClassContext = {
  dir: '/tmp/mint-teach-test',
  meta: {
    id: 'c1',
    title: 'Linear algebra',
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    stage: 'active',
    mission: { topic: 'Linear algebra', why: 'Read ML papers.', successLooksLike: [], constraints: [], outOfScope: [] },
    intake: { timeline: '', timePerWeek: '', sessionLength: '', priorExperience: '', preferences: '', materialsMode: 'own' },
    trustedDomains: [],
    hue: 120
  },
  sources: [],
  curriculum: null,
  progress: {},
  records: [],
  glossary: [],
  independence: { level: 0, score: 0, defaultRung: 1, reason: '', history: [], asks: 0 }
}

describe('teach skill (mint edition)', () => {
  it('splits a skill into its sections, ignoring frontmatter and preamble', () => {
    const s = parseSections('---\nname: x\n---\n# Title\nintro\n## A\none\n\n## B\ntwo\n### sub\nthree\n')
    expect([...s.keys()]).toEqual(['A', 'B'])
    expect(s.get('B')).toBe('two\n### sub\nthree')
  })

  it('bundles every section mint asks for', () => {
    const all = teach(...(Object.keys(TEACH_SECTIONS).filter((k) => k !== 'core') as Parameters<typeof teach>))
    for (const heading of Object.values(TEACH_SECTIONS).slice(1)) expect(all).toContain(`## ${heading}`)
    expect(all).toContain('the more the learner uses mint, the less they need it')
  })

  it('gives each job Core plus only the sections it needs', async () => {
    const runtime = capturingRuntime()
    await makeQuiz({ runtime, ctx }, 'eigenvalues')
    await intakeQuestions({ runtime, ctx }, 'I want to read ML papers')
    await tutorReply(
      { runtime, ctx },
      {
        thread: { id: 't', classId: 'c1', title: '', anchor: { kind: 'general' }, messages: [{ id: 'm', role: 'user', text: 'what is a basis?', at: '' }], createdAt: '', updatedAt: '' } as never,
        rung: 1,
        anchorContext: ''
      },
      () => {}
    )
    const [quiz, intake, reply] = runtime.requests.map((r) => r.system)
    for (const system of [quiz, intake, reply]) expect(system).toContain('The learner\'s materials are the authority')

    expect(quiz).toContain('## Practice and feedback')
    expect(quiz).toContain('all options of a question have about the same length')
    expect(quiz).not.toContain('## Help ladder')

    expect(intake).toContain('## Intake and mission')
    expect(intake).not.toContain('## Practice and feedback')

    expect(reply).toContain('## Help ladder')
    expect(reply).toContain('## Wisdom')
    expect(reply).toContain('HELP RUNG 1 (POINTER)')
  })
})
