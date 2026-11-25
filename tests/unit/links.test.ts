import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { linksFromInput, linksIn, MAX_LINKS } from '@shared/links'
import type { ProgressEvent } from '@shared/types'
import { allTopics } from '@shared/curriculum'
import { createCore, type MintCore } from '../../src/main/app'
import { importUrl, listPlaylist, parseYouTubePlaylistId, resolveLink, type YouTubeClient } from '../../src/main/sources'
import { dispositionFileName } from '../../src/main/sources/net'
import { validateCurriculum, withoutTopic } from '../../src/main/learning/curriculum'
import { buildDocx, buildPdf } from '../fixtures/sources/builders'

const root = resolve(import.meta.dirname, '../..')
const DOC = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit?usp=sharing'
const DOC_EXPORT = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=docx'
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** A fetch that answers from a table and remembers what it was asked for. */
function table(routes: Record<string, () => Response>): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    asked.push(url)
    return routes[url]?.() ?? new Response('Not found', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, asked }
}

const ok = (body: BodyInit, type: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { 'content-type': type, ...headers } })

describe('links in text', () => {
  it('finds links however they were pasted, without what surrounds them', () => {
    expect(linksIn('See https://a.example/x, then (https://b.example/y).\nhttps://en.wikipedia.org/wiki/Rust_(programming_language)')).toEqual([
      'https://a.example/x',
      'https://b.example/y',
      'https://en.wikipedia.org/wiki/Rust_(programming_language)'
    ])
    expect(linksIn('https://a.example/x https://a.example/x')).toEqual(['https://a.example/x'])
    expect(linksIn('no links here, not even ftp://old.example/file')).toEqual([])
    expect(linksIn('http://localhost https://')).toEqual([])
  })

  it('takes a lone address typed without its scheme', () => {
    expect(linksFromInput('arxiv.org/abs/1706.03762')).toEqual(['https://arxiv.org/abs/1706.03762'])
    expect(linksFromInput('  https://a.example/x  ')).toEqual(['https://a.example/x'])
    expect(linksFromInput('eigenvectors and eigenvalues')).toEqual([])
    expect(linksFromInput('')).toEqual([])
  })
})

describe('shared links are read from the address that serves the document', () => {
  it('turns viewer pages into downloads and keeps the page as the link', () => {
    expect(resolveLink(DOC)).toEqual({ fetchUrl: DOC_EXPORT, pageUrl: DOC, service: 'google' })
    expect(resolveLink('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#slide=id.p').fetchUrl).toBe(
      'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export/pdf'
    )
    expect(resolveLink('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=42').fetchUrl).toBe(
      'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=csv&gid=42'
    )
    expect(resolveLink('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing').fetchUrl).toBe(
      'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvWxYz012345'
    )
    expect(resolveLink('https://arxiv.org/abs/1706.03762v7').fetchUrl).toBe('https://arxiv.org/pdf/1706.03762v7')
    expect(resolveLink('https://github.com/rust-lang/book/blob/main/src/ch04-01-what-is-ownership.md').fetchUrl).toBe(
      'https://raw.githubusercontent.com/rust-lang/book/main/src/ch04-01-what-is-ownership.md'
    )
    expect(resolveLink('https://www.dropbox.com/s/abc123/notes.pdf?dl=0').fetchUrl).toBe('https://www.dropbox.com/s/abc123/notes.pdf?dl=1')
    // Anything else is fetched as it is.
    for (const plain of ['https://en.wikipedia.org/wiki/Linear_algebra', 'https://github.com/rust-lang/book', 'https://arxiv.org/pdf/1706.03762', 'not a link']) {
      expect(resolveLink(plain)).toEqual({ fetchUrl: plain, pageUrl: plain })
    }
  })

  it('reads the name a server gives a download', () => {
    expect(dispositionFileName('attachment; filename="Linear algebra notes.docx"; filename*=UTF-8\'\'Linear%20algebra%20notes.docx')).toBe('Linear algebra notes.docx')
    expect(dispositionFileName('attachment; filename=notes.pdf')).toBe('notes.pdf')
    expect(dispositionFileName('inline')).toBeUndefined()
    expect(dispositionFileName(null)).toBeUndefined()
  })

  it('imports a Google Doc as the Word document behind it', async () => {
    const { fetchImpl, asked } = table({
      [DOC_EXPORT]: () =>
        ok(buildDocx([{ text: 'Vectors', heading: 1 }, { text: 'A vector has a length and a direction.' }]), DOCX_TYPE, { 'content-disposition': 'attachment; filename="Vector notes.docx"' })
    })
    const source = await importUrl(DOC, { fetchImpl })
    expect(asked).toEqual([DOC_EXPORT])
    expect(source).toMatchObject({ kind: 'docx', title: 'Vector notes', url: DOC, domain: 'docs.google.com' })
    expect(source.sections[0].blocks.some((b) => b.text.includes('length and a direction'))).toBe(true)
  })

  it('imports a Word document from any link, by its type or by its name', async () => {
    const docx = buildDocx([{ text: 'Only paragraph.' }])
    const byName = await importUrl('https://cs.example.edu/handouts/week-1.docx', {
      fetchImpl: table({ 'https://cs.example.edu/handouts/week-1.docx': () => ok(docx, 'application/octet-stream') }).fetchImpl
    })
    expect(byName).toMatchObject({ kind: 'docx', title: 'week-1', url: 'https://cs.example.edu/handouts/week-1.docx' })
    // Another kind of zip is not a Word document.
    await expect(importUrl('https://cs.example.edu/code.zip', { fetchImpl: table({ 'https://cs.example.edu/code.zip': () => ok(docx, 'application/zip') }).fetchImpl })).rejects.toThrow(
      /can't import application\/zip/
    )
  })

  it('reads a paper from its abstract page and a file from its GitHub page', async () => {
    const { fetchImpl, asked } = table({
      'https://arxiv.org/pdf/1706.03762': () => ok(buildPdf([['Attention is all you need.']]), 'application/pdf'),
      'https://raw.githubusercontent.com/o/r/main/docs/guide.md': () => ok('# Guide\n\nStart here.', 'text/plain; charset=utf-8')
    })
    const paper = await importUrl('https://arxiv.org/abs/1706.03762', { fetchImpl })
    expect(paper).toMatchObject({ kind: 'pdf', url: 'https://arxiv.org/abs/1706.03762', domain: 'arxiv.org' })
    const guide = await importUrl('https://github.com/o/r/blob/main/docs/guide.md', { fetchImpl })
    expect(guide).toMatchObject({ kind: 'markdown', title: 'Guide', url: 'https://github.com/o/r/blob/main/docs/guide.md', domain: 'github.com' })
    expect(asked).toEqual(['https://arxiv.org/pdf/1706.03762', 'https://raw.githubusercontent.com/o/r/main/docs/guide.md'])
  })

  it('says how to share a Google file that answers with a sign-in page or a refusal', async () => {
    const signIn = table({ [DOC_EXPORT]: () => ok('<!doctype html><html><body><h1>Sign in</h1><p>to continue to Google Docs</p></body></html>', 'text/html') })
    await expect(importUrl(DOC, { fetchImpl: signIn.fetchImpl })).rejects.toThrow(/not shared by link/)
    const refused = table({ [DOC_EXPORT]: () => new Response('', { status: 401 }) })
    await expect(importUrl(DOC, { fetchImpl: refused.fetchImpl })).rejects.toThrow(/Anyone with the link/)
    // Another failure is reported as what it is.
    await expect(importUrl(DOC, { fetchImpl: table({}).fetchImpl })).rejects.toThrow(/HTTP 404/)
  })
})

/** A YouTube stand-in: two videos with a transcript, in one playlist. */
const PLAYLIST = 'PLabcdefghij0123456789'
const VIDEOS: Record<string, string> = { aaaaaaaaaaa: 'Vectors', bbbbbbbbbbb: 'Matrices' }
const youtube: YouTubeClient = {
  getInfo: async (id) => {
    if (!VIDEOS[id]) throw new Error('video unavailable')
    return {
      basic_info: { title: VIDEOS[id], author: 'A teacher' },
      getTranscript: async () => ({
        transcript: { content: { body: { initial_segments: [{ type: 'TranscriptSegment', start_ms: '0', snippet: { text: `All about ${VIDEOS[id].toLowerCase()}.` } }] } } }
      })
    }
  },
  getPlaylist: async (id) => {
    if (id !== PLAYLIST) throw new Error('playlist unavailable')
    return {
      info: { title: 'Linear algebra, the course' },
      // One video twice, one that cannot be loaded, and a row that is not a video.
      items: [
        { type: 'PlaylistVideo', id: 'aaaaaaaaaaa' },
        { type: 'LockupView', content_id: 'bbbbbbbbbbb' },
        { type: 'PlaylistVideo', id: 'aaaaaaaaaaa' },
        { type: 'PlaylistVideo', id: 'ccccccccccc' },
        { type: 'Message' }
      ],
      has_continuation: false
    }
  }
}

describe('playlists', () => {
  it('tells a playlist from a video opened in one', () => {
    expect(parseYouTubePlaylistId(`https://www.youtube.com/playlist?list=${PLAYLIST}`)).toBe(PLAYLIST)
    expect(parseYouTubePlaylistId(`https://www.youtube.com/watch?v=aaaaaaaaaaa&list=${PLAYLIST}`)).toBeNull()
    expect(parseYouTubePlaylistId('https://example.com/playlist?list=PLabcdefghij0123456789')).toBeNull()
  })

  it('lists the videos of a playlist once each, in order', async () => {
    const list = await listPlaylist(`https://www.youtube.com/playlist?list=${PLAYLIST}`, { innertube: youtube })
    expect(list).toEqual({ title: 'Linear algebra, the course', videoIds: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'], truncated: false })
    await expect(listPlaylist('https://www.youtube.com/playlist?list=PLzzzzzzzzzzzzzzzzzzzz', { innertube: youtube })).rejects.toThrow(/Could not load this YouTube playlist/)
  })
})

describe('links as materials, and removing a lesson', () => {
  let dir: string
  let core: MintCore
  const progress: ProgressEvent[] = []
  const article = readFileSync(join(root, 'tests/fixtures/sources/article.html'), 'utf8')
  const ARTICLE = 'https://www.mathnotes.example/eigen'
  const net = table({
    [ARTICLE]: () => ok(article, 'text/html; charset=utf-8'),
    [DOC_EXPORT]: () =>
      ok(buildDocx([{ text: 'Vectors', heading: 1 }, { text: 'A vector has a length and a direction.' }]), DOCX_TYPE, { 'content-disposition': 'attachment; filename="Vector notes.docx"' })
  })

  async function until<T>(fn: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mint-links-'))
    core = createCore({
      dataDir: dir,
      cipher: { available: () => true, encrypt: (p) => p, decrypt: (c) => c },
      fetchImpl: net.fetchImpl,
      youtube,
      emitter: { stream: () => undefined, progress: (e) => progress.push(e), classChanged: () => undefined },
      host: { platform: 'darwin', pickFiles: async () => [], openPath: async () => undefined, openExternal: async () => undefined }
    })
    await core.handlers.settings.update({ provider: 'demo' })
  })

  afterAll(async () => {
    await core.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts a class from links alone and names it after the first one', async () => {
    const meta = await core.handlers.classes.start({ urls: [DOC, ARTICLE], mode: 'simple' })
    expect(meta.title).toBe('New class')
    const bundle = await until(async () => {
      const b = await core.handlers.classes.get(meta.id)
      return b.sources.length === 2 && b.meta.title !== 'New class' && b
    })
    expect(bundle.meta.title).toBe('Vector notes')
    expect(bundle.sources.map((s) => s.kind)).toEqual(['docx', 'web'])
    // A simple class lists what the links contain, like any other material.
    await until(async () => (await core.handlers.classes.get(meta.id)).contents)
  })

  it('adds several links at once: each on its own, a playlist as its videos, nothing twice', async () => {
    const meta = await core.handlers.classes.start({ title: 'Links', mode: 'simple' })
    await expect(core.handlers.sources.addLinks(meta.id, ['not a link'])).rejects.toThrow(/Paste a link/)

    const first = await core.handlers.sources.addLinks(meta.id, [`${ARTICLE} and https://missing.example/page`, `https://www.youtube.com/playlist?list=${PLAYLIST}`])
    expect(first.added.map((s) => s.kind)).toEqual(['web', 'youtube', 'youtube'])
    expect(first.added.map((s) => s.title).slice(1)).toEqual(['Vectors', 'Matrices'])
    expect(first.errors).toHaveLength(2)
    expect(first.errors[0]).toMatch(/^missing\.example: .*HTTP 404/)
    expect(first.errors[1]).toMatch(/^Video ccccccccccc: /)

    // The same links again add nothing, and say why.
    const again = await core.handlers.sources.addLinks(meta.id, [ARTICLE, 'https://youtu.be/aaaaaaaaaaa'])
    expect(again.added).toEqual([])
    expect(again.errors).toEqual([expect.stringMatching(/is already in this class/), '"Vectors" is already in this class.'])
    expect((await core.handlers.classes.get(meta.id)).sources).toHaveLength(3)

    const many = Array.from({ length: MAX_LINKS + 3 }, (_, i) => `https://missing.example/${i}`)
    const capped = await core.handlers.sources.addLinks(meta.id, many)
    expect(capped.errors[0]).toMatch(new RegExp(`first ${MAX_LINKS} links`))
    expect(capped.errors).toHaveLength(MAX_LINKS + 1)
  })

  it('adds the page the Browser tab shows from what it shows, and a video or a document from its address', async () => {
    const meta = await core.handlers.classes.start({ title: 'Pages', mode: 'simple' })
    const before = net.asked.length
    // Nothing answers at this address for a fetch: only what the tab shows can be read.
    const page = await core.handlers.sources.addPage(meta.id, 'https://members.example/lesson/3', article)
    expect(page).toMatchObject({ kind: 'web', url: 'https://members.example/lesson/3', domain: 'members.example' })
    expect(net.asked.length).toBe(before)

    const video = await core.handlers.sources.addPage(meta.id, 'https://www.youtube.com/watch?v=bbbbbbbbbbb', '<html><body><div id="player"></div></body></html>')
    expect(video).toMatchObject({ kind: 'youtube', title: 'Matrices' })
    const doc = await core.handlers.sources.addPage(meta.id, DOC, '<html><body><div class="kix-appview-editor">editor</div></body></html>')
    expect(doc).toMatchObject({ kind: 'docx', title: 'Vector notes' })
    // A page with nothing to read in it is fetched instead.
    const shell = await core.handlers.sources.addPage(meta.id, ARTICLE, '<html><body><embed type="application/pdf"></body></html>')
    expect(shell.kind).toBe('web')
    await expect(core.handlers.sources.addPage(meta.id, 'file:///etc/hosts', article)).rejects.toThrow(/Only web pages/)
  })

  it('removes a lesson from the plan with its progress, and a revised plan leaves it out', async () => {
    const meta = await core.handlers.classes.start({ title: 'Plan', paths: [join(root, 'tests/fixtures/e2e/eigen.md')] })
    await until(async () => (await core.handlers.classes.get(meta.id)).sources.length === 1)
    await core.handlers.intake.autoPlan(meta.id)
    let bundle = await core.handlers.classes.get(meta.id)
    const topics = allTopics(bundle.curriculum)
    expect(topics.length).toBeGreaterThanOrEqual(3)
    const [first, second, third] = topics
    expect(second.prerequisites).toEqual([first.id])
    expect(third.prerequisites).toEqual([second.id])

    // A lesson under way in the one that goes.
    const session = await core.handlers.sessions.start(meta.id, second.id, 'learn')
    expect((await core.handlers.classes.get(meta.id)).meta.openLessonId).toBe(session.id)

    await core.handlers.intake.removeTopic(meta.id, second.id)
    bundle = await core.handlers.classes.get(meta.id)
    const left = allTopics(bundle.curriculum)
    expect(left.map((t) => t.id)).toEqual(topics.filter((t) => t.id !== second.id).map((t) => t.id))
    // What needed it now needs what it needed.
    expect(left.find((t) => t.id === third.id)?.prerequisites).toEqual([first.id])
    expect(bundle.curriculum?.removed).toEqual([second.title])
    expect(bundle.progress[second.id]).toBeUndefined()
    expect(bundle.sessions).toEqual([])
    expect(bundle.meta.openLessonId).toBeUndefined()
    await expect(core.handlers.intake.removeTopic(meta.id, second.id)).rejects.toThrow(/not in the plan anymore/)

    // Planning again does not bring it back.
    await core.handlers.intake.autoPlan(meta.id, 'More practice.')
    bundle = await core.handlers.classes.get(meta.id)
    expect(allTopics(bundle.curriculum).some((t) => t.title === second.title)).toBe(false)
    expect(bundle.curriculum?.removed).toEqual([second.title])
  })

  it('drops a part of the plan left with no lessons, and forgets a removal the plan undoes', () => {
    const topic = (id: string, prerequisites: string[] = []) => ({ id, title: id.toUpperCase(), objective: '', prerequisites, sources: [], practice: '', gate: '' })
    const plan = {
      version: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      summary: '',
      project: null,
      assumptions: [],
      cadence: '',
      milestones: [
        { id: 'm1', title: 'One', deliverable: '', topics: [topic('a')] },
        { id: 'm2', title: 'Two', deliverable: '', topics: [topic('b', ['a']), topic('c', ['a', 'b'])] }
      ]
    }
    const next = withoutTopic(plan, 'a')!
    expect(next.milestones.map((m) => m.id)).toEqual(['m2'])
    expect(next.milestones[0].topics.map((t) => t.prerequisites)).toEqual([[], ['b']])
    expect(next.version).toBe(3)
    expect(next.removed).toEqual(['A'])
    expect(withoutTopic(next, 'b')?.removed).toEqual(['A', 'B'])
    expect(withoutTopic(plan, 'nope')).toBeNull()
    // A plan that has a removed lesson again was asked for it: it is no longer remembered as removed.
    const raw = {
      summary: '',
      project: null,
      assumptions: [],
      cadence: '',
      milestones: [{ title: 'Two', deliverable: '', topics: [{ title: 'A', objective: '', prerequisites: [], sources: [], practice: '', gate: '' }] }]
    }
    expect(validateCurriculum(raw, [], withoutTopic(next, 'b')).curriculum.removed).toEqual(['B'])
  })
})
