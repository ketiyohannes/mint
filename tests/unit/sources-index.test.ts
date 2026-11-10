import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { importFile, importUrl, toAgentMarkdown, type YouTubeClient } from '../../src/main/sources'
import { buildDocx, buildPdf } from '../fixtures/sources/builders'

const FIXTURES = join(__dirname, '../fixtures/sources')

function serve(body: BodyInit, contentType: string): typeof fetch {
  return (async () => new Response(body, { status: 200, headers: { 'content-type': contentType } })) as typeof fetch
}

describe('importFile', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mint-sources-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('dispatches by extension and keeps originals', async () => {
    const md = join(dir, 'notes.md')
    await writeFile(md, '# Notes\n\nHello.')
    const mdSource = await importFile(md)
    expect(mdSource.kind).toBe('markdown')
    expect(mdSource.original?.ext).toBe('md')

    const txt = join(dir, 'plain.TXT')
    await writeFile(txt, '﻿First.\r\n\r\nSecond.')
    const txtSource = await importFile(txt)
    expect(txtSource.kind).toBe('text')
    expect(txtSource.sections[0].blocks.map((b) => b.text)).toEqual(['First.', 'Second.'])

    const html = join(dir, 'article.html')
    await writeFile(html, await readFile(join(FIXTURES, 'article.html')))
    const htmlSource = await importFile(html)
    expect(htmlSource.kind).toBe('html')
    expect(htmlSource.url).toBeUndefined()
    expect(htmlSource.original?.ext).toBe('html')

    const pdf = join(dir, 'paper.pdf')
    await writeFile(pdf, buildPdf([['A page of text.']]))
    expect((await importFile(pdf)).kind).toBe('pdf')

    const docx = join(dir, 'essay.docx')
    await writeFile(docx, buildDocx([{ text: 'Body text.' }]))
    expect((await importFile(docx)).kind).toBe('docx')
  })

  it('rejects unsupported types and lists the supported ones', async () => {
    const file = join(dir, 'slides.pptx')
    await writeFile(file, 'x')
    await expect(importFile(file)).rejects.toThrow(/Supported files: PDF \(\.pdf\), Markdown/)
  })
})

describe('importUrl', () => {
  it('imports HTML pages as web sources', async () => {
    const html = await readFile(join(FIXTURES, 'article.html'), 'utf8')
    const source = await importUrl('https://www.mathnotes.example/eigen', {
      fetchImpl: serve(html, 'text/html; charset=utf-8')
    })
    expect(source.kind).toBe('web')
    expect(source.domain).toBe('mathnotes.example')
    expect(source.sections.length).toBeGreaterThan(1)
  })

  it('imports PDFs with url and domain set', async () => {
    const source = await importUrl('https://arxiv.example/pdf/2401.00001', {
      fetchImpl: serve(buildPdf([['Abstract text.']]), 'application/octet-stream')
    })
    expect(source.kind).toBe('pdf')
    expect(source.url).toBe('https://arxiv.example/pdf/2401.00001')
    expect(source.domain).toBe('arxiv.example')
    // A numeric path segment is not a useful name, so the domain becomes the title.
    expect(source.title).toBe('arxiv.example')

    const named = await importUrl('https://cs.example.edu/~prof/lecture_notes.pdf', {
      fetchImpl: serve(buildPdf([['Notes.']]), 'application/pdf')
    })
    expect(named.title).toBe('lecture notes')
  })

  it('imports plain text and markdown, falling back to the domain for the title', async () => {
    const text = await importUrl('https://www.example.com/', { fetchImpl: serve('Hello.\n\nWorld.', 'text/plain') })
    expect(text).toMatchObject({ kind: 'text', title: 'example.com', domain: 'example.com' })

    const md = await importUrl('https://raw.example.com/repo/README.md', {
      fetchImpl: serve('# Project\n\nIntro.', 'text/plain; charset=utf-8')
    })
    expect(md).toMatchObject({ kind: 'markdown', title: 'Project', url: 'https://raw.example.com/repo/README.md' })
  })

  it('routes YouTube links to the transcript importer', async () => {
    const innertube: YouTubeClient = {
      getInfo: async () => ({
        basic_info: { title: 'Video' },
        getTranscript: async () => ({
          transcript: {
            content: { body: { initial_segments: [{ type: 'TranscriptSegment', start_ms: '0', snippet: { text: 'Hi.' } }] } }
          }
        })
      })
    }
    const source = await importUrl('https://youtu.be/dQw4w9WgXcQ', {
      innertube,
      fetchImpl: (() => {
        throw new Error('should not fetch')
      }) as typeof fetch
    })
    expect(source.kind).toBe('youtube')
    expect(toAgentMarkdown({ id: 'v1', ...source })).toContain('[00:00] Hi.  ^s0b0')
  })

  it('rejects unsupported content types', async () => {
    await expect(importUrl('https://example.com/pic.png', { fetchImpl: serve(new Uint8Array([137, 80, 78, 71]), 'image/png') })).rejects.toThrow(/can't import image\/png from example\.com/)
  })
})
