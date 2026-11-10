import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { extractDirectives, splitDirectives } from '@shared/directives'
import { matchSection, validateCurriculum, type RawCurriculum } from '../../src/main/learning/curriculum'
import { applyCheck, applyReviewOutcome, computeIndependence, emptyProgress, nextTopicId, recomputeProgress, reviewsDue } from '../../src/main/learning/engine'
import { findQuote, segmentText } from '../../src/renderer/src/lib/anchors'
import { toStrictJsonSchema } from '../../src/main/jobs/run'
import { sanitizeDiagram } from '../../src/main/services/diagrams'
import type { HelpEvent, Session, SourceMeta } from '@shared/types'

describe('directives', () => {
  it('parses citations, highlights and slider moves, leaving malformed ones as text', () => {
    const text = 'See [[cite:src_1|p. 12|stays on its own line]] then [[highlight:bob]] and [[set:angle=45]]. Bad: [[set:angle=x]] [[nope:1]]'
    const ds = extractDirectives(text)
    expect(ds).toEqual([
      { type: 'cite', sourceId: 'src_1', section: 'p. 12', quote: 'stays on its own line' },
      { type: 'highlight', elementId: 'bob' },
      { type: 'set', paramId: 'angle', value: 45 }
    ])
    const segs = splitDirectives(text)
    expect(
      segs
        .filter((s) => s.kind === 'text')
        .map((s) => (s.kind === 'text' ? s.text : ''))
        .join('')
    ).toContain('[[set:angle=x]]')
  })
})

const src = (id: string): SourceMeta => ({ id, classId: 'c', kind: 'markdown', title: id, origin: 'user', addedAt: '', wordCount: 1, sectionCount: 2 })

describe('curriculum validation (code repairs the model)', () => {
  const raw: RawCurriculum = {
    summary: 's',
    project: null,
    assumptions: [' a '],
    cadence: 'weekly',
    milestones: [
      {
        title: 'M1',
        deliverable: 'd',
        topics: [
          { id: 'basics', title: 'Basics', objective: 'o', prerequisites: ['later', 'ghost'], sources: [{ sourceId: 's1', section: 'p.2' }], practice: '', gate: '' },
          { id: 'basics', title: 'Basics two', objective: 'o', prerequisites: ['Basics'], sources: [{ sourceId: 'missing', section: 'x' }], practice: '', gate: '' }
        ]
      },
      { title: 'Empty', deliverable: '', topics: [] },
      { title: 'M2', deliverable: 'd', topics: [{ id: 'later', title: 'Later', objective: 'o', prerequisites: ['basics'], sources: [{ sourceId: 's1', section: 'Nowhere' }], practice: '', gate: '' }] }
    ]
  }
  const sources = [{ meta: src('s1'), sectionLabels: ['p. 1', 'p. 2'] }]

  it('dedupes ids, drops loops/unknown prereqs, fixes source refs, reports repairs', () => {
    const { curriculum, repairs } = validateCurriculum(raw, sources, null)
    const topics = curriculum.milestones.flatMap((m) => m.topics)
    expect(topics.map((t) => t.id)).toEqual(['basics', 'basics-2', 'later'])
    expect(topics[0].prerequisites).toEqual([]) // forward + unknown removed
    expect(topics[1].prerequisites).toEqual(['basics'])
    expect(topics[1].sources).toEqual([])
    expect(topics[0].sources[0].section).toBe('p. 2') // "p.2" normalized
    expect(topics[2].sources[0].section).toBe('p. 1') // unknown section → start
    expect(curriculum.milestones).toHaveLength(2)
    expect(repairs.length).toBeGreaterThanOrEqual(5)
    expect(curriculum.version).toBe(1)
  })

  it('keeps topic ids stable across revisions so progress carries over', () => {
    const first = validateCurriculum(raw, sources, null).curriculum
    const renamed = { ...raw, milestones: [{ ...raw.milestones[0], topics: [{ ...raw.milestones[0].topics[0], id: 'brand-new-id' }] }] }
    const second = validateCurriculum(renamed, sources, first).curriculum
    expect(second.milestones[0].topics[0].id).toBe('basics')
    expect(second.version).toBe(2)
  })

  it('matches section labels loosely', () => {
    expect(matchSection('page 12', ['p. 11', 'p. 12'])).toBe('p. 12')
    expect(matchSection('eigen', ['Intro', 'Eigenvalues'])).toBe('Eigenvalues')
    expect(matchSection('zzz', ['Intro'])).toBeNull()
  })

  it('reads a page range as its first page, not as a shorter page number', () => {
    const pages = Array.from({ length: 40 }, (_, i) => `p. ${i + 1}`)
    expect(matchSection('p. 25-27', pages)).toBe('p. 25')
    expect(matchSection('pp. 12-14', pages)).toBe('p. 12')
    expect(matchSection('pages 3 to 5', pages)).toBe('p. 3')
  })

  it('does not take a heading that starts with "p" for a page locator', () => {
    expect(matchSection('Conditional Probability', ['Intro', 'Probability'])).toBe('Probability')
    expect(matchSection('2.3 Proofs', ['Intro', 'Proofs', 'Summary'])).toBe('Proofs')
    expect(matchSection('probability', ['Intro', 'Probability'])).toBe('Probability')
  })

  it('matches labels in any script, and never matches on nothing', () => {
    const labels = ['Введение', 'Собственные значения', '结论']
    expect(matchSection('собственные значения', labels)).toBe('Собственные значения')
    expect(matchSection('结论', labels)).toBe('结论')
    expect(matchSection('Заключение', labels)).toBeNull()
    expect(matchSection('eigenvalues', labels)).toBeNull()
    expect(matchSection('...', ['Intro', '***'])).toBeNull()
    expect(matchSection('', ['Intro'])).toBeNull()
  })
})

describe('learning engine', () => {
  const curriculum = validateCurriculum(
    {
      summary: '',
      project: null,
      assumptions: [],
      cadence: '',
      milestones: [
        {
          title: 'M',
          deliverable: '',
          topics: [
            { id: 'a', title: 'A', objective: '', prerequisites: [], sources: [], practice: '', gate: '' },
            { id: 'b', title: 'B', objective: '', prerequisites: ['a'], sources: [], practice: '', gate: '' }
          ]
        }
      ]
    },
    [],
    null
  ).curriculum
  const session = (type: Session['type']): Session => ({ id: 's', classId: 'c', topicId: 'a', type, phase: 'explain', startedAt: '', prompts: {}, attempts: [] })

  it('unlocks topics only when prerequisites are mastered, and schedules reviews', () => {
    let progress = recomputeProgress(curriculum, {})
    expect(progress.a.status).toBe('available')
    expect(progress.b.status).toBe('locked')
    expect(nextTopicId(curriculum, progress)).toBe('a')
    const now = new Date('2026-01-01T00:00:00Z')
    let a = progress.a
    for (const k of ['explain', 'apply', 'distinguish'] as const) a = applyCheck(a, k, true, session('learn'), now)
    progress = recomputeProgress(curriculum, { ...progress, a })
    expect(progress.a.status).toBe('mastered')
    expect(progress.a.nextReviewAt).toBe('2026-01-02T00:00:00.000Z')
    expect(progress.b.status).toBe('available')
    expect(reviewsDue(progress, new Date('2026-01-03T00:00:00Z'))).toEqual(['a'])
    expect(reviewsDue(progress, new Date('2026-01-01T12:00:00Z'))).toEqual([])
  })

  it('a failed check never counts, and reviews move along the spacing ladder', () => {
    const p = applyCheck(emptyProgress('a'), 'explain', false, session('learn'))
    expect(p.checks.explain.passed).toBe(false)
    const now = new Date('2026-01-01T00:00:00Z')
    const up = applyReviewOutcome({ ...p, reviewStage: 1 }, true, now)
    expect(up.reviewStage).toBe(2)
    expect(up.nextReviewAt).toBe('2026-01-08T00:00:00.000Z')
    const down = applyReviewOutcome({ ...p, reviewStage: 3 }, false, now)
    expect(down.reviewStage).toBe(0)
  })

  it('independence rises as the learner needs less help, and needs evidence first', () => {
    const ev = (i: number, rung: 1 | 2 | 3 | 4, escalated = false, defaultRung: 1 | 2 | 3 | 4 = 3): HelpEvent => ({
      id: `h${i}`,
      at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      threadId: `t${i}`,
      rung,
      defaultRung,
      escalated
    })
    const few = computeIndependence([ev(1, 3), ev(2, 3)], [], [])
    expect(few.level).toBe(0)
    expect(few.defaultRung).toBe(3)
    // A Guided learner (hint by default) who never needs more help moves up.
    const selfSufficient = computeIndependence(
      Array.from({ length: 12 }, (_, i) => ev(i, 3)),
      [],
      []
    )
    expect(selfSufficient.level).toBe(2)
    expect(selfSufficient.defaultRung).toBe(1)
    // ...but full independence also needs passed checks.
    const passed: Session = {
      id: 's',
      classId: 'c',
      topicId: 'a',
      type: 'learn',
      phase: 'wrap',
      startedAt: '',
      prompts: {},
      attempts: Array.from({ length: 6 }, (_, i) => ({
        id: `a${i}`,
        kind: 'explain' as const,
        prompt: '',
        answer: '' as const,
        at: '',
        verdict: { result: 'pass' as const, feedback: '', misconceptions: [] }
      }))
    }
    expect(
      computeIndependence(
        Array.from({ length: 12 }, (_, i) => ev(i, 3)),
        [passed],
        []
      ).level
    ).toBe(3)
    // Escalating two rungs to a full explanation every time keeps support high.
    const needy = computeIndependence(
      Array.from({ length: 12 }, (_, i) => ev(i, 4, true, 2)),
      [],
      []
    )
    expect(needy.level).toBe(0)
    // One extra rung each time costs half the credit.
    expect(
      computeIndependence(
        Array.from({ length: 12 }, (_, i) => ev(i, 4, true, 3)),
        [],
        []
      ).level
    ).toBe(1)
  })

  it('counts only the final rung of an escalated ask', () => {
    const events: HelpEvent[] = [
      { id: 'h1', at: '2026-01-01T00:00:01Z', threadId: 't', rung: 2, defaultRung: 2, escalated: false },
      { id: 'h2', at: '2026-01-01T00:00:02Z', threadId: 't', rung: 3, defaultRung: 2, escalated: true },
      { id: 'h3', at: '2026-01-01T00:00:03Z', threadId: 't', rung: 4, defaultRung: 2, escalated: true }
    ]
    expect(computeIndependence(events, [], []).asks).toBe(1)
  })
})

describe('reader anchors', () => {
  it('splits text into non-overlapping marked segments', () => {
    const segs = segmentText('abcdefghij', [
      { start: 2, end: 6, kind: 'highlight', id: 'h' },
      { start: 4, end: 8, kind: 'thread', id: 't' }
    ])
    expect(segs.map((s) => [s.text, s.marks.map((m) => m.kind).join('+')])).toEqual([
      ['ab', ''],
      ['cd', 'highlight'],
      ['ef', 'highlight+thread'],
      ['gh', 'thread'],
      ['ij', '']
    ])
  })

  it('finds quotes despite punctuation and spacing differences', () => {
    const blocks = [
      { id: 'b1', text: 'Intro text.' },
      { id: 'b2', text: 'They stay on the same line — through the origin, and stretch.' }
    ]
    const hit = findQuote(blocks, 'stay on the same line through the origin')
    expect(hit?.blockId).toBe('b2')
    expect(blocks[1].text.slice(hit!.start, hit!.end)).toBe('stay on the same line — through the origin')
    expect(findQuote(blocks, 'stay on the same line plus words that do not exist')?.blockId).toBe('b2')
    expect(findQuote(blocks, 'zebra unicorn quartz')).toBeNull()
  })
})

describe('structured-output schemas', () => {
  it('closes every object and requires every property (works for Claude and Codex)', () => {
    const schema = toStrictJsonSchema(z.object({ a: z.string(), b: z.object({ c: z.number().nullable() }), list: z.array(z.object({ d: z.boolean() })) }))
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return
      const o = n as Record<string, unknown>
      if (o.type === 'object') {
        expect(o.additionalProperties).toBe(false)
        expect(o.required).toEqual(Object.keys(o.properties as object))
      }
      Object.values(o).forEach(walk)
    }
    walk(schema)
    expect(schema.$schema).toBeUndefined()
  })
})

describe('diagram sanitizing', () => {
  it('clamps params, dedupes ids, and rejects empty code', () => {
    const spec = sanitizeDiagram({
      engine: 'p5',
      title: '',
      code: 'function setup(){}',
      caption: 'c',
      elements: [
        { id: 'a', label: 'A', description: '' },
        { id: 'a', label: 'dup', description: '' },
        { id: '', label: 'none', description: '' }
      ],
      params: [
        { id: 'x', label: 'X', min: 0, max: 10, step: 0, value: 99 },
        { id: 'bad', label: 'Bad', min: 5, max: 1, step: 1, value: 2 }
      ]
    })
    expect(spec.elements.map((e) => e.id)).toEqual(['a'])
    expect(spec.params).toEqual([{ id: 'x', label: 'X', min: 0, max: 10, step: 0.1, value: 10 }])
    expect(spec.title).toBe('Explorable')
    expect(() => sanitizeDiagram({ engine: 'three', title: 't', code: '  ', caption: '', elements: [], params: [] })).toThrow(/without any code/)
  })
})

describe('settings store', () => {
  it('persists only known settings keys, dropping retired ones', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { SettingsStore } = await import('../../src/main/store/settingsStore')
    const dir = mkdtempSync(join(tmpdir(), 'mint-settings-'))
    const store = new SettingsStore(dir, { available: () => true, encrypt: (p) => p, decrypt: (c) => c })
    await store.update({ ttsRate: 9, speakReplies: true, trustedDomains: ['https://www.Example.org/path', 'not a domain'], dataDir: '/evil' } as never)
    const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(saved.dataDir).toBeUndefined()
    expect(saved.ttsRate).toBeUndefined()
    expect(saved.speakReplies).toBeUndefined()
    expect(saved.trustedDomains).toEqual(['example.org'])
  })

  it('forgets the OpenAI key the old voice tutor used, keeping the Anthropic key', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { SettingsStore } = await import('../../src/main/store/settingsStore')
    const dir = mkdtempSync(join(tmpdir(), 'mint-secrets-'))
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ anthropic: 'enc-a', openai: 'enc-o' }))
    const store = new SettingsStore(dir, { available: () => true, encrypt: (p) => p, decrypt: (c) => c })
    await store.forgetRetiredSecrets()
    expect(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))).toEqual({ anthropic: 'enc-a' })
    expect(await store.getSecret('anthropic')).toBe('enc-a')
  })
})

describe('tutor offers', () => {
  it('parses quiz, code and diagram offers and rejects unknown tools', () => {
    const text = 'Try it. [[offer:quiz|eigenvalues]] Or [[offer:code|scaling | in python]] and [[offer:diagram|a stretch]] [[offer:shell|rm -rf]]'
    const ds = extractDirectives(text)
    expect(ds).toEqual([
      { type: 'offer', tool: 'quiz', arg: 'eigenvalues' },
      { type: 'offer', tool: 'code', arg: 'scaling | in python' },
      { type: 'offer', tool: 'diagram', arg: 'a stretch' }
    ])
  })
})
