import { describe, expect, it } from 'vitest'
import type { AgentRuntime, AgentTurnRequest } from '../../src/main/agents/types'
import type { ClassContext } from '../../src/main/jobs/context'
import type { Session, Topic } from '../../src/shared/types'
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
    for (const system of [quiz, intake, reply]) expect(system).toContain('The learner\'s materials are the reference')

    expect(quiz).toContain('## Practice and feedback')
    expect(quiz).toContain('all options of a question have about the same length')
    expect(quiz).not.toContain('## Explaining and the help ladder')

    expect(intake).toContain('## Intake and mission')
    expect(intake).not.toContain('## Practice and feedback')

    expect(reply).toContain('## Explaining and the help ladder')
    expect(reply).toContain('## Wisdom')
    expect(reply).toContain('HELP RUNG 1 (POINTER)')
  })

  it('teaches in depth at the explanation rung, with the materials as reference', async () => {
    const runtime = capturingRuntime()
    await tutorReply(
      { runtime, ctx },
      {
        thread: { id: 't', classId: 'c1', title: '', anchor: { kind: 'general' }, messages: [{ id: 'm', role: 'user', text: 'what is a basis?', at: '' }], createdAt: '', updatedAt: '' } as never,
        rung: 4,
        anchorContext: ''
      },
      () => {}
    )
    const { system } = runtime.requests[0]
    expect(system).toContain('EXPLAIN LIKE A TEACHER')
    expect(system).toContain('Never answer by pointing to the materials or restating them')
    expect(system).toContain('Teach from the source, in your own words')
    expect(system).toContain('teach it anyway from general knowledge')
    expect(system).not.toContain('Send the learner back to the source')
  })

  it('lets the tutor in a lesson chat see the study box, including an unsent answer', async () => {
    const runtime = capturingRuntime()
    const thread = { id: 't', classId: 'c1', title: '', anchor: { kind: 'general' }, sessionId: 's1', messages: [{ id: 'm', role: 'user', text: 'is my answer on track?', at: '' }], createdAt: '', updatedAt: '' } as never
    const session: Session = {
      id: 's1',
      classId: 'c1',
      topicId: 'eigen',
      type: 'learn',
      phase: 'apply',
      startedAt: '',
      brief: { win: 'Find eigenvalues by hand.', whyItMatters: 'PCA is built on them.', readings: [], questions: ['What does A do to an eigenvector?'] },
      prompts: { explain: 'Explain what an eigenvector is.', apply: 'Find the eigenvalues of [[2,0],[0,3]].' },
      attempts: [
        { id: 'a1', kind: 'explain', prompt: '', answer: 'A vector that only gets scaled.', at: '', verdict: { result: 'pass', feedback: 'Right, and the scale is the eigenvalue.', misconceptions: [] } }
      ]
    }
    const topic = { id: 'eigen', title: 'Eigenvalues', objective: 'Compute eigenvalues of 2x2 matrices', prerequisites: [], sources: [] } as unknown as Topic
    const text = await tutorReply({ runtime, ctx }, { thread, rung: 1, anchorContext: '', session, sessionTopic: topic, studyDraft: { kind: 'apply', text: 'The diagonal entries, so 2 and 3' } }, () => {})
    const { system, prompt } = runtime.requests[0]

    expect(system).toContain('you can see it')
    for (const shown of [
      'Lesson: Eigenvalues. Objective: Compute eigenvalues of 2x2 matrices',
      'Apply (current)',
      'The win: Find eigenvalues by hand.',
      '1. What does A do to an eigenvector?',
      '### Explain check (passed)',
      'Attempt 1: "A vector that only gets scaled."',
      'Feedback (Pass): Right, and the scale is the eigenvalue.',
      '### Apply check (not passed yet)',
      'Question: Find the eigenvalues of [[2,0],[0,3]].',
      'Being written now, not submitted yet: "The diagonal entries, so 2 and 3"'
    ])
      expect(prompt).toContain(shown)
    expect(text).toContain('**Apply** step')

    // Outside a lesson there is no study box.
    await tutorReply({ runtime, ctx }, { thread: { ...(thread as object), sessionId: undefined } as never, rung: 1, anchorContext: '' }, () => {})
    expect(runtime.requests[1].prompt).not.toContain('study box')
    expect(runtime.requests[1].system).not.toContain('you can see it')
  })
})
