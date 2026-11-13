import { describe, expect, it } from 'vitest'
import type { AgentRuntime, AgentTurnRequest } from '../../src/main/agents/types'
import type { ClassContext } from '../../src/main/jobs/context'
import type { CheckAttempt, Session, Topic } from '../../src/shared/types'
import { checkPrompt, describeStudyBox, intakeQuestions, judgeCheck, makeQuiz, tutorReply } from '../../src/main/jobs'
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
    for (const system of [quiz, intake, reply]) expect(system).toContain("The learner's materials are the reference")

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
    // An idea is built from the problem it answered (Toeplitz's genetic method), without made-up history.
    expect(system).toContain('How to explain an idea: from the problem it answers')
    expect(system).toContain('Never invent history')
    expect(system).toContain('the exact statement last')
    // And it is written to be read easily.
    expect(system).toContain('Plain, everyday English')
    expect(system).toContain('a small question gets a short answer')
  })

  it('asks for plain, easy writing in everything the learner reads, not only chat replies', async () => {
    const runtime = capturingRuntime()
    await makeQuiz({ runtime, ctx }, 'eigenvectors')
    await intakeQuestions({ runtime, ctx }, 'I want to learn linear algebra')
    for (const { system } of runtime.requests) {
      expect(system).toContain('## Writing (everything the learner reads')
      expect(system).toContain('Easy to read, never intimidating')
      // The writing rules come before the formatting contract, which stays last.
      expect(system.indexOf('## Writing')).toBeLessThan(system.indexOf('## Formatting'))
    }
    expect(runtime.requests.length).toBe(2)
  })

  it('lets the tutor in a lesson chat see the study box, including an unsent answer', async () => {
    const runtime = capturingRuntime()
    const thread = {
      id: 't',
      classId: 'c1',
      title: '',
      anchor: { kind: 'general' },
      sessionId: 's1',
      messages: [{ id: 'm', role: 'user', text: 'is my answer on track?', at: '' }],
      createdAt: '',
      updatedAt: ''
    } as never
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
        {
          id: 'a1',
          kind: 'explain',
          prompt: '',
          answer: 'A vector that only gets scaled.',
          at: '',
          verdict: { result: 'pass', feedback: 'Right, and the scale is the eigenvalue.', misconceptions: [] }
        }
      ]
    }
    const topic = { id: 'eigen', title: 'Eigenvalues', objective: 'Compute eigenvalues of 2x2 matrices', prerequisites: [], sources: [] } as unknown as Topic
    const text = await tutorReply(
      { runtime, ctx },
      { thread, rung: 1, anchorContext: '', session, sessionTopic: topic, studyDraft: { kind: 'apply', text: 'The diagonal entries, so 2 and 3' } },
      () => {}
    )
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

  it('judges a retry with the earlier tries and its own feedback in view', async () => {
    const runtime = capturingRuntime()
    const topic = { id: 'eigen', title: 'Eigenvalues', objective: 'Compute eigenvalues of 2x2 matrices', prerequisites: [], sources: [] } as unknown as Topic
    const first: CheckAttempt = {
      id: 'att1',
      kind: 'explain',
      prompt: 'Explain eigenvalues.',
      answer: 'An eigenvector is a direction the matrix only stretches.',
      at: '2026-11-09T00:00:00.000Z',
      verdict: { result: 'partial', feedback: 'Say what the eigenvalue is.', misconceptions: ['eigenvalues are directions'] }
    }
    const verdict = await judgeCheck(
      { runtime, ctx },
      topic,
      'explain',
      'Explain eigenvalues.',
      'And the stretch factor along that direction is the eigenvalue, so A times x equals lambda times x.',
      '',
      [first]
    )
    const prompt = runtime.requests[0].prompt
    expect(prompt).toContain('Earlier tries at this check')
    expect(prompt).toContain('An eigenvector is a direction the matrix only stretches.')
    expect(prompt).toContain('Your feedback: Say what the eigenvalue is.')
    expect(prompt).toContain('Misconceptions you named: eigenvalues are directions')
    expect(prompt).toContain("Learner's new try:\nAnd the stretch factor")
    expect(runtime.requests[0].system).toContain('repair after your feedback')
    // The scripted judge counts the earlier try too: the repair alone would only be partial.
    expect(verdict.result).toBe('pass')
    expect(verdict.feedback).toMatch(/^Building on your earlier try/)

    const fresh = capturingRuntime()
    await judgeCheck({ runtime: fresh, ctx }, topic, 'explain', 'Explain eigenvalues.', 'A first answer here.', '')
    expect(fresh.requests[0].prompt).not.toContain('Earlier tries')
    expect(fresh.requests[0].prompt).toContain("Learner's answer:")
  })

  it('asks for code when the subject is done in code, in a language mint can show', async () => {
    const topic = { id: 'bs', title: 'Binary search', objective: 'Write a binary search function in Rust', prerequisites: [], sources: [], practice: '' } as unknown as Topic
    /** A model that answers a check prompt as given. */
    const answering = (structured: unknown): AgentRuntime & { requests: AgentTurnRequest[] } => {
      const runtime = capturingRuntime()
      runtime.run = async (req) => {
        runtime.requests.push(req)
        return { text: JSON.stringify(structured), structured }
      }
      return runtime
    }

    const cpp = answering({ prompt: ' Write `lower_bound`. ', answer: 'code', language: 'C++' })
    expect(await checkPrompt({ runtime: cpp, ctx }, topic, undefined, 'apply')).toEqual({ prompt: 'Write `lower_bound`.', language: 'cpp' })
    const system = cpp.requests[0].system
    expect(system).toContain('Fit the task to the subject')
    expect(system).toContain('ask for code')
    for (const id of ['python', 'c', 'cpp', 'typescript', 'rust', 'zig']) expect(system).toContain(`"${id}"`)
    expect(system).toContain('## Writing') // the plain-English rules still apply to the question

    // A language mint has no grammar for is still code, written as plain text.
    expect((await checkPrompt({ runtime: answering({ prompt: 'p', answer: 'code', language: 'OCaml' }), ctx }, topic, undefined, 'apply')).language).toBe('plain')
    // A written answer has no language, whatever the field says.
    expect((await checkPrompt({ runtime: answering({ prompt: 'p', answer: 'text', language: 'python' }), ctx }, topic, undefined, 'distinguish')).language).toBeNull()

    // Explain-back is the brief's own questions: no model, and a written answer.
    const none = capturingRuntime()
    const explain = await checkPrompt({ runtime: none, ctx }, topic, { win: '', whyItMatters: '', readings: [], questions: ['Why halve the range?'] }, 'explain')
    expect(explain).toEqual({ prompt: 'Without looking back at the text, explain in your own words:\n\n- Why halve the range?', language: null })
    expect(none.requests).toHaveLength(0)

    // The scripted tutor asks for code on a topic about code, in the language it names.
    const demo = capturingRuntime()
    expect((await checkPrompt({ runtime: demo, ctx }, topic, undefined, 'apply')).language).toBe('rust')
    const prose = { ...topic, title: 'Eigenvalues', objective: 'Compute eigenvalues of 2x2 matrices' } as Topic
    expect((await checkPrompt({ runtime: demo, ctx }, prose, undefined, 'apply')).language).toBeNull()
  })

  it('tells the judge how to read code, and the chat tutor that a check is answered in code', async () => {
    const runtime = capturingRuntime()
    const topic = { id: 'bs', title: 'Binary search', objective: 'Write a binary search', prerequisites: [], sources: [] } as unknown as Topic
    const answer = 'Halve the range each step.\n\n```rust\nfn find(xs: &[i32], x: i32) -> Option<usize> { xs.binary_search(&x).ok() }\n```'
    await judgeCheck({ runtime, ctx }, topic, 'apply', 'Write a binary search.', answer, '')
    expect(runtime.requests[0].system).toContain('You cannot run it')
    expect(runtime.requests[0].system).toContain('never write the corrected solution')
    expect(runtime.requests[0].prompt).toContain('```rust\nfn find')

    const session = {
      id: 's1',
      classId: 'c1',
      topicId: 'bs',
      type: 'learn',
      phase: 'apply',
      startedAt: '',
      prompts: { apply: 'Write a binary search.' },
      codeChecks: { apply: 'rust' },
      attempts: []
    } as Session
    const box = describeStudyBox(ctx, session, topic, { kind: 'apply', text: '```rust\nfn find() {}\n```' })
    expect(box).toContain('The answer box is a code editor (Rust)')
    expect(box).toContain('fn find() {}')
  })
})
