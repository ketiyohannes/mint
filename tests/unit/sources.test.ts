import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SourceSection } from '@shared/types'
import { importDocx } from '../../src/main/sources/docx'
import { importHtml } from '../../src/main/sources/html'
import { normalizeSections, toAgentMarkdown, wordCount, formatTimestamp } from '../../src/main/sources/normalize'
import { importPdf, pageTextToBlocks } from '../../src/main/sources/pdf'
import { importMarkdown, importPlainText } from '../../src/main/sources/text'
import { buildDocx, buildPdf } from '../fixtures/sources/builders'

const FIXTURES = join(__dirname, '../fixtures/sources')

function allText(sections: SourceSection[]): string {
  return sections.flatMap((s) => s.blocks.map((b) => b.text)).join('\n')
}

describe('normalizeSections', () => {
  it('assigns contiguous ids after dropping empty blocks and sections', () => {
    const sections = normalizeSections([
      { label: 'Empty', blocks: [{ type: 'paragraph', text: '   ' }] },
      {
        label: '  Intro  ',
        blocks: [
          { type: 'paragraph', text: '  Hello\n\n   world\t again ' },
          { type: 'paragraph', text: '' },
          { type: 'heading', text: 'Sub', level: 9 }
        ]
      },
      { label: 'Code', title: 'Code', blocks: [{ type: 'code', text: '\n\ndef f():\r\n    return 1   \n\n' }] }
    ])

    expect(sections.map((s) => s.id)).toEqual(['s0', 's1'])
    expect(sections[0]).toEqual({
      id: 's0',
      label: 'Intro',
      blocks: [
        { id: 's0b0', type: 'paragraph', text: 'Hello world again' },
        { id: 's0b1', type: 'heading', text: 'Sub', level: 6 }
      ]
    })
    expect(sections[1].blocks[0]).toEqual({ id: 's1b0', type: 'code', text: 'def f():\n    return 1' })
  })

  it('keeps cue times and section times', () => {
    const [section] = normalizeSections([
      { label: '01:00', t: 60, blocks: [{ type: 'cue', text: 'hi', t: 61.5 }] }
    ])
    expect(section.t).toBe(60)
    expect(section.blocks[0]).toEqual({ id: 's0b0', type: 'cue', text: 'hi', t: 61.5 })
  })

  it('splits overlong paragraphs at sentence boundaries', () => {
    const sentence = 'This sentence is about forty-five characters. '
    const long = sentence.repeat(60) // ~2800 chars
    const [section] = normalizeSections([{ label: 'L', blocks: [{ type: 'paragraph', text: long }] }])

    expect(section.blocks.length).toBeGreaterThanOrEqual(3)
    for (const block of section.blocks) {
      expect(block.type).toBe('paragraph')
      expect(block.text.length).toBeLessThanOrEqual(1200)
      expect(block.text.endsWith('characters.')).toBe(true)
    }
    expect(section.blocks.map((b) => b.text).join(' ')).toBe(long.trim())
  })

  it('does not split list items or quotes', () => {
    const long = 'word '.repeat(400)
    const [section] = normalizeSections([{ label: 'L', blocks: [{ type: 'quote', text: long }] }])
    expect(section.blocks).toHaveLength(1)
  })

  it('counts words', () => {
    const sections = normalizeSections([
      { label: 'A', blocks: [{ type: 'paragraph', text: 'one two  three' }, { type: 'cue', text: 'four' }] }
    ])
    expect(wordCount(sections)).toBe(4)
  })

  it('formats timestamps', () => {
    expect(formatTimestamp(0)).toBe('00:00')
    expect(formatTimestamp(75.9)).toBe('01:15')
    expect(formatTimestamp(3725)).toBe('1:02:05')
  })
})

describe('toAgentMarkdown', () => {
  it('renders the exact agent format', () => {
    const sections = normalizeSections([
      {
        label: 'Introduction',
        blocks: [
          { type: 'paragraph', text: 'Eigenvalues matter.' },
          { type: 'list-item', text: 'First point' },
          { type: 'quote', text: 'A quote' }
        ]
      },
      {
        label: 'Computing them',
        title: 'Computing them, in detail',
        blocks: [
          { type: 'heading', text: 'Example', level: 3 },
          { type: 'code', text: 'x = 1\ny = 2' }
        ]
      },
      { label: '01:05', title: '01:05', t: 65, blocks: [{ type: 'cue', text: 'So here we go', t: 65 }] }
    ])

    const md = toAgentMarkdown({ id: 'src_1', title: 'Eigen', kind: 'web', url: 'https://example.com/e', sections })
    expect(md).toBe(
      [
        '# Eigen',
        'source-id: src_1 · kind: web · url: https://example.com/e',
        '',
        '## [Introduction]',
        'Eigenvalues matter.  ^s0b0',
        '- First point  ^s0b1',
        '> A quote  ^s0b2',
        '',
        '## [Computing them] Computing them, in detail',
        '### Example  ^s1b0',
        '```',
        'x = 1',
        'y = 2',
        '```',
        '^s1b1',
        '',
        '## [01:05]',
        '[01:05] So here we go  ^s2b0',
        ''
      ].join('\n')
    )
  })

  it('omits the url when absent and lengthens fences around backticks', () => {
    const sections = normalizeSections([{ label: 'A', blocks: [{ type: 'code', text: 'echo ```' }] }])
    const md = toAgentMarkdown({ id: 'x', title: 'T', kind: 'markdown', sections })
    expect(md).toContain('source-id: x · kind: markdown\n')
    expect(md).toContain('````\necho ```\n````\n^s0b0')
  })
})

describe('importMarkdown', () => {
  const markdown = [
    '---',
    'tags: [notes]',
    '---',
    'Preamble with **bold** and a [link](https://example.com).',
    '',
    '# Linear Algebra Notes',
    '',
    'Vectors are arrows.',
    'They have *direction* and magnitude.',
    '',
    '## Eigenvalues',
    '',
    '### Definition',
    '',
    '- Item one',
    '- Item `two`',
    '  continues here',
    '1. Numbered',
    '',
    '> A quoted line',
    '> continues',
    '',
    '```python',
    'def f(x):',
    '    return x  # keep indentation',
    '```',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    'snake_case_name stays intact.'
  ].join('\n')

  it('turns # and ## into sections and deeper headings into blocks', () => {
    const source = importMarkdown(markdown, 'notes.md')
    expect(source.kind).toBe('markdown')
    expect(source.title).toBe('Linear Algebra Notes')
    expect(source.sections.map((s) => s.label)).toEqual(['Introduction', 'Linear Algebra Notes', 'Eigenvalues'])

    expect(source.sections[0].blocks).toEqual([
      { id: 's0b0', type: 'paragraph', text: 'Preamble with bold and a link.' }
    ])
    expect(source.sections[1].blocks).toEqual([
      { id: 's1b0', type: 'paragraph', text: 'Vectors are arrows. They have direction and magnitude.' }
    ])

    const eigen = source.sections[2].blocks.map(({ type, text, level }) => ({ type, text, level }))
    expect(eigen).toEqual([
      { type: 'heading', text: 'Definition', level: 3 },
      { type: 'list-item', text: 'Item one', level: undefined },
      { type: 'list-item', text: 'Item two continues here', level: undefined },
      { type: 'list-item', text: 'Numbered', level: undefined },
      { type: 'quote', text: 'A quoted line continues', level: undefined },
      { type: 'code', text: 'def f(x):\n    return x  # keep indentation', level: undefined },
      { type: 'paragraph', text: 'a | b', level: undefined },
      { type: 'paragraph', text: '1 | 2', level: undefined },
      { type: 'paragraph', text: 'snake_case_name stays intact.', level: undefined }
    ])
  })

  it('uses front matter title, then file name', () => {
    expect(importMarkdown('---\ntitle: "From Front"\n---\nBody', 'x.md').title).toBe('From Front')
    expect(importMarkdown('Just text.\n\n### Small heading\n\nMore.', 'my_notes.md').title).toBe('my notes')
  })

  it('splits documents without # or ## headings into parts', () => {
    const source = importMarkdown('One.\n\n### Small\n\nTwo.', 'x.md')
    expect(source.sections.map((s) => s.label)).toEqual(['Part 1'])
  })

  it('supports setext headings', () => {
    const source = importMarkdown('Title\n=====\n\nBody text.\n\nNext\n----\n\nMore.', 'x.md')
    expect(source.sections.map((s) => s.label)).toEqual(['Title', 'Next'])
  })
})

describe('importPlainText', () => {
  it('splits paragraphs on blank lines and groups 30 per part', () => {
    const paragraphs = Array.from({ length: 65 }, (_, i) => `Paragraph ${i + 1}\nwrapped line.`)
    const source = importPlainText(paragraphs.join('\n\n'), 'essay.txt')
    expect(source.kind).toBe('text')
    expect(source.title).toBe('essay')
    expect(source.sections.map((s) => [s.label, s.blocks.length])).toEqual([
      ['Part 1', 30],
      ['Part 2', 30],
      ['Part 3', 5]
    ])
    expect(source.sections[0].blocks[0].text).toBe('Paragraph 1 wrapped line.')
  })

  it('rejects empty text', () => {
    expect(() => importPlainText(' \n\n ', 'empty.txt')).toThrow(/no text/)
  })
})

describe('importHtml', () => {
  it('extracts the article and drops navigation, sidebar, and footer', async () => {
    const html = await readFile(join(FIXTURES, 'article.html'), 'utf8')
    const source = importHtml(html, 'https://www.mathnotes.example/posts/eigen', 'fallback')

    expect(source.kind).toBe('web')
    expect(source.domain).toBe('mathnotes.example')
    expect(source.url).toBe('https://www.mathnotes.example/posts/eigen')
    expect(source.title).toContain('Understanding Eigenvalues')

    const text = allText(source.sections)
    for (const junk of ['Subscribe to our newsletter', 'Popular posts', 'Advertisement', 'Copyright 2026', 'analytics']) {
      expect(text).not.toContain(junk)
    }

    const labels = source.sections.map((s) => s.label)
    expect(labels).toContain('What an eigenvector is')
    expect(labels).toContain('Computing them')
    expect(labels[0]).toBe('Introduction')

    const eigen = source.sections.find((s) => s.label === 'What an eigenvector is')!
    expect(eigen.blocks.filter((b) => b.type === 'list-item').map((b) => b.text)).toEqual([
      'Eigenvectors are directions that are preserved.',
      'Eigenvalues are the scale factors along those directions.',
      'A matrix can have repeated eigenvalues.'
    ])
    expect(eigen.blocks.find((b) => b.type === 'quote')?.text).toBe(
      'The eigenvectors of a matrix are the skeleton on which its behaviour hangs.'
    )
    // Inline <em>/<code> text is kept, with spacing intact.
    expect(eigen.blocks[0].text).toContain('matrix A is a non-zero vector v that')

    const computing = source.sections.find((s) => s.label === 'Computing them')!
    expect(computing.blocks.map((b) => b.type)).toEqual(['paragraph', 'heading', 'code', 'paragraph'])
    expect(computing.blocks[1]).toMatchObject({ text: 'A worked example in code', level: 3 })
    expect(computing.blocks[2].text).toBe(
      'import numpy as np\n\nA = np.array([[2, 0], [0, 3]])\nvalues, vectors = np.linalg.eig(A)\nprint(values)  # [2. 3.]'
    )
  })

  it('is kind html for local files and falls back to the body for tiny pages', () => {
    const source = importHtml(
      '<html><body><nav>Menu</nav><div>Short note<br>with a break</div><footer>foot</footer></body></html>',
      undefined,
      'note'
    )
    expect(source.kind).toBe('html')
    expect(source.domain).toBeUndefined()
    expect(source.title).toBe('note')
    expect(allText(source.sections)).toBe('Short note with a break')
  })

  it('truncates long headings to 60-char labels and keeps the full title', () => {
    const heading = 'A very long heading that keeps going and going well past the sixty character limit'
    const source = importHtml(`<body><h2>${heading}</h2><p>Body.</p></body>`, undefined, 'x')
    expect(source.sections[0].label.length).toBeLessThanOrEqual(60)
    expect(source.sections[0].label.endsWith('…')).toBe(true)
    expect(source.sections[0].title).toBe(heading)
  })

  it('throws when there is no text', () => {
    expect(() => importHtml('<html><body><script>x()</script></body></html>', undefined, 'x')).toThrow(/readable text/)
  })
})

describe('importPdf', () => {
  it('imports one section per page with paragraphs and de-hyphenation', async () => {
    const bytes = buildPdf(
      [
        [
          'Photosynthesis is the process by which green plants turn light',
          'into chemical energy. It takes place in the chloroplasts of the',
          'leaf and needs water and carbon dioxide.',
          'Chlorophyll absorbs mostly red and blue light and reflects the',
          'green part of the spectrum, which is why leaves look green to us.'
        ],
        ['The light reactions produce oxygen as a by-product of splitting', 'water. This infor-', 'mation is well established.']
      ],
      { title: 'Plant Biology Primer' }
    )
    const original = bytes.slice()
    const source = await importPdf(bytes, 'biology.pdf')

    expect(source.kind).toBe('pdf')
    expect(source.title).toBe('Plant Biology Primer')
    expect(source.sections.map((s) => s.label)).toEqual(['p. 1', 'p. 2'])
    expect(source.original?.ext).toBe('pdf')
    expect(source.original?.bytes).toEqual(original)

    const page1 = source.sections[0].blocks.map((b) => b.text)
    expect(page1).toEqual([
      'Photosynthesis is the process by which green plants turn light into chemical energy. It takes place in the chloroplasts of the leaf and needs water and carbon dioxide.',
      'Chlorophyll absorbs mostly red and blue light and reflects the green part of the spectrum, which is why leaves look green to us.'
    ])
    expect(allText([source.sections[1]])).toContain('This information is well established.')
  })

  it('falls back to the file name when the PDF has no title', async () => {
    const source = await importPdf(buildPdf([['Hello world.']]), 'lecture_notes.pdf')
    expect(source.title).toBe('lecture notes')
  })

  it('rejects PDFs without selectable text', async () => {
    await expect(importPdf(buildPdf([[], []]), 'scan.pdf')).rejects.toThrow(/no selectable text/)
  })

  it('rejects files that are not PDFs', async () => {
    await expect(importPdf(new TextEncoder().encode('not a pdf'), 'x.pdf')).rejects.toThrow(/could not be read as a PDF/)
  })
})

describe('pageTextToBlocks', () => {
  it('splits on blank lines and bullets, joins wrapped lines, drops page numbers', () => {
    const blocks = pageTextToBlocks(
      [
        '12',
        'The first paragraph of this page is long enough that it wraps onto',
        'a second line.',
        '',
        '• A bullet point',
        '• Another one.',
        'The closing paragraph is also long enough to wrap, and it splits a para-',
        'graph across the line break.',
        '13'
      ].join('\n')
    )
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'The first paragraph of this page is long enough that it wraps onto a second line.' },
      { type: 'list-item', text: 'A bullet point' },
      { type: 'list-item', text: 'Another one.' },
      { type: 'paragraph', text: 'The closing paragraph is also long enough to wrap, and it splits a paragraph across the line break.' }
    ])
  })
})

describe('importDocx', () => {
  it('converts headings to sections and keeps the original', async () => {
    const bytes = buildDocx([
      { text: 'Opening remarks before any heading.' },
      { text: 'Cell Biology', heading: 1 },
      { text: 'Cells are the basic unit of life.' },
      { text: 'Organelles', heading: 3 },
      { text: 'Mitochondria produce energy.' },
      { text: 'Genetics', heading: 2 },
      { text: 'DNA carries hereditary information.' }
    ])
    const source = await importDocx(bytes, 'Biology Notes.docx')

    expect(source.kind).toBe('docx')
    expect(source.title).toBe('Biology Notes')
    expect(source.original).toEqual({ bytes, ext: 'docx' })
    expect(source.sections.map((s) => s.label)).toEqual(['Introduction', 'Cell Biology', 'Genetics'])
    expect(source.sections[1].blocks.map(({ type, text }) => ({ type, text }))).toEqual([
      { type: 'paragraph', text: 'Cells are the basic unit of life.' },
      { type: 'heading', text: 'Organelles' },
      { type: 'paragraph', text: 'Mitochondria produce energy.' }
    ])
  })

  it('rejects non-docx bytes', async () => {
    await expect(importDocx(new TextEncoder().encode('nope'), 'x.docx')).rejects.toThrow(/Word document/)
  })
})
