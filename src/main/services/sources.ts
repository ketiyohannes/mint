import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SourceDoc, SourceMeta, SourceOrigin, SourceProposal } from '@shared/types'
import { MAX_LINKS } from '@shared/links'
import {
  domainOf,
  importFile,
  importUrl,
  isDomainAllowed,
  listPlaylist,
  normalizeSections,
  parseYouTubeId,
  parseYouTubePlaylistId,
  resolveLink,
  transcriptFromText,
  wordCount,
  type ImportedSource
} from '../sources'
import { importHtml } from '../sources/html'
import { expandPaths } from '../sources/expand'
import { newId, nowIso } from '../store/fsutil'
import { proposeSources } from '../jobs'
import type { Kernel } from './kernel'
import { userError, userMessage } from './kernel'

/** A pasted transcript longer than this is cut (far beyond any real video). */
const MAX_TRANSCRIPT_CHARS = 2_000_000
/** A page handed over by the Browser tab that is larger than this is fetched from its address instead. */
const MAX_PAGE_CHARS = 6_000_000

export class SourceService {
  /** Approved proposals this run is importing right now. */
  private importing = new Set<string>()
  /** Classes already checked for imports an earlier run left unfinished. */
  private recovered = new Set<string>()

  constructor(private readonly k: Kernel) {}

  async addFiles(classId: string, paths: string[]): Promise<{ added: SourceMeta[]; errors: string[] }> {
    await this.k.repo.requireMeta(classId)
    const added: SourceMeta[] = []
    const errors: string[] = []
    const { files, truncated } = await expandPaths(paths)
    if (!files.length) errors.push('No readable files found (PDF, Markdown, text, HTML or Word).')
    if (truncated) errors.push(`Imported the first ${files.length} files. Add the rest separately if you need them.`)
    for (const path of files) {
      try {
        const imported = await this.k.job(classId, `Reading ${basename(path)}`, () => importFile(path))
        added.push(await this.store(classId, imported, 'user'))
      } catch (err) {
        errors.push(`${basename(path)}: ${userMessage(err)}`)
      }
    }
    return { added, errors }
  }

  async addUrl(classId: string, url: string, origin: SourceOrigin = 'user', why?: string): Promise<SourceMeta> {
    await this.k.repo.requireMeta(classId)
    const trimmed = url.trim()
    if (!/^https?:\/\//i.test(trimmed)) throw userError('Links must start with http:// or https://')
    const imported = await this.k.job(classId, `Importing ${domainOf(trimmed) || 'link'}`, async () => {
      try {
        return await importUrl(trimmed, { fetchImpl: this.k.opts.fetchImpl, innertube: this.k.opts.youtube })
      } catch (err) {
        throw userError(userMessage(err))
      }
    })
    return this.store(classId, imported, origin, why)
  }

  /**
   * Add several links. Each is imported on its own, so one that fails does not
   * stop the others; a playlist is every video in it. A link the class already
   * has is left alone.
   */
  async addLinks(classId: string, links: string[]): Promise<{ added: SourceMeta[]; errors: string[] }> {
    await this.k.repo.requireMeta(classId)
    const added: SourceMeta[] = []
    const errors: string[] = []
    if (links.length > MAX_LINKS) errors.push(`Added the first ${MAX_LINKS} links. Add the rest separately.`)
    /** The class was deleted meanwhile: the links that are left have nowhere to go. */
    let gone = false
    const addOne = async (url: string, name: string): Promise<void> => {
      gone ||= !(await this.k.repo.readMeta(classId))
      if (gone) return
      try {
        const have = await this.find(classId, url)
        if (have) errors.push(`"${have.title}" is already in this class.`)
        else added.push(await this.addUrl(classId, url))
      } catch (err) {
        errors.push(`${name}: ${userMessage(err)}`)
      }
    }
    for (const url of links.slice(0, MAX_LINKS)) {
      if (gone) break
      if (!parseYouTubePlaylistId(url)) {
        await addOne(url, domainOf(url) || url.slice(0, 60))
        continue
      }
      try {
        const list = await this.k.job(classId, 'Reading the playlist', () => listPlaylist(url, { innertube: this.k.opts.youtube }))
        if (list.truncated) errors.push(`"${list.title}" is a long playlist: added its first ${list.videoIds.length} videos.`)
        for (const id of list.videoIds) await addOne(`https://www.youtube.com/watch?v=${id}`, `Video ${id}`)
      } catch (err) {
        errors.push(userMessage(err))
      }
    }
    return { added, errors }
  }

  /**
   * Add the page the Browser tab is showing, from what it shows: the page as
   * the learner sees it, signed in and after its scripts ran, which fetching
   * the address again would not give. A video or a document is still read
   * from its address (what a page shows of those is a player or a viewer),
   * and so is a page with no readable text in it.
   */
  async addPage(classId: string, url: string, html: string): Promise<SourceMeta> {
    await this.k.repo.requireMeta(classId)
    const trimmed = String(url ?? '').trim()
    if (!/^https?:\/\//i.test(trimmed)) throw userError('Only web pages can be added.')
    const page = String(html ?? '')
    if (page && page.length <= MAX_PAGE_CHARS && !parseYouTubeId(trimmed) && resolveLink(trimmed).fetchUrl === trimmed) {
      let imported: ImportedSource | null = null
      try {
        imported = await this.k.job(classId, `Reading ${domainOf(trimmed) || 'the page'}`, async () => importHtml(page, trimmed, domainOf(trimmed)))
      } catch {
        // Nothing readable in what the page shows (a PDF in the viewer, an empty shell): its address may still serve it.
      }
      if (imported) return this.store(classId, imported, 'user')
    }
    return this.addUrl(classId, trimmed)
  }

  /** The source a link is already imported as, if any. */
  private async find(classId: string, url: string): Promise<SourceMeta | undefined> {
    const videoId = parseYouTubeId(url)
    return (await this.k.repo.read(classId, 'sources')).find((s) => (videoId ? s.videoId === videoId : s.url === url))
  }

  async get(classId: string, sourceId: string): Promise<SourceDoc> {
    return this.k.repo.readSource(classId, sourceId)
  }

  /** The original PDF bytes, for the page view. Other kinds are read from the normalized text. */
  async original(classId: string, sourceId: string): Promise<Uint8Array | null> {
    const doc = await this.k.repo.readSource(classId, sourceId)
    if (doc.kind !== 'pdf' || !doc.originalFile || !/^sources\/[\w-]+\/original\.pdf$/.test(doc.originalFile)) return null
    try {
      return new Uint8Array(await readFile(join(this.k.repo.dir(classId), doc.originalFile)))
    } catch {
      return null
    }
  }

  async remove(classId: string, sourceId: string): Promise<void> {
    await this.k.repo.lock(classId, async () => {
      await this.k.repo.update(classId, 'sources', (list) => list.filter((s) => s.id !== sourceId))
      await this.k.repo.update(classId, 'proposals', (list) => list.map((p) => (p.sourceId === sourceId ? { ...p, status: 'rejected' as const, sourceId: undefined } : p)))
      await this.k.repo.removeSource(classId, sourceId)
    })
    this.k.changed(classId)
  }

  /** Attach a pasted transcript to a video that had none. */
  async setTranscript(classId: string, sourceId: string, input: string): Promise<SourceMeta> {
    const text = String(input ?? '').slice(0, MAX_TRANSCRIPT_CHARS)
    if (!text.trim()) throw userError('Paste the transcript text first.')
    return this.k.repo.lock(classId, async () => {
      const doc = await this.k.repo.readSource(classId, sourceId)
      // Only a video's text is a transcript; any other source keeps what was imported.
      if (doc.kind !== 'youtube') throw userError('Only a video can take a pasted transcript.')
      const sections = normalizeSections(transcriptFromText(text))
      if (!sections.length) throw userError('That transcript has no readable text.')
      const next: SourceDoc = { ...doc, sections, needsTranscript: false, wordCount: wordCount(sections), sectionCount: sections.length }
      await this.k.repo.writeSource(next)
      const meta = toMeta(next)
      await this.k.repo.update(classId, 'sources', (list) => list.map((s) => (s.id === sourceId ? meta : s)))
      this.k.changed(classId)
      return meta
    })
  }

  /**
   * Ask the agent for trusted public sources. It is told to stay on the class's
   * allowlist; a suggestion from another domain is kept but marked `newDomain`,
   * and approving it is what trusts that domain.
   */
  async proposeTrusted(classId: string, focus?: string): Promise<void> {
    const existing = await this.k.repo.read(classId, 'sources')
    const proposals = await this.k.repo.read(classId, 'proposals')
    const ctx = await this.k.context(classId)
    const result = await this.k.job(classId, 'Finding trusted sources', async () =>
      proposeSources({ runtime: await this.k.runtime(), ctx }, focus, [...existing.map((s) => s.url ?? ''), ...proposals.map((p) => p.url)].filter(Boolean))
    )
    const allow = ctx.meta.trustedDomains
    const seen = new Set([...existing.map((s) => s.url), ...proposals.map((p) => p.url)])
    const fresh: SourceProposal[] = []
    for (const p of result.proposals) {
      let url: URL
      try {
        url = new URL(p.url.trim())
      } catch {
        continue // Code drops anything that is not a real URL.
      }
      if (!/^https?:$/.test(url.protocol) || seen.has(url.href)) continue
      seen.add(url.href)
      const isVideo = Boolean(parseYouTubeId(url.href))
      fresh.push({
        id: newId('prop'),
        title: p.title.trim().slice(0, 200) || url.hostname,
        url: url.href,
        domain: domainOf(url.href),
        kind: isVideo ? 'youtube' : 'web',
        why: p.why.trim().slice(0, 400),
        covers: p.covers.trim().slice(0, 400),
        newDomain: !isDomainAllowed(url.href, allow),
        status: 'proposed'
      })
    }
    if (!fresh.length) throw userError('No usable sources were found on your trusted domains. Try a different focus, or add domains in the Library.')
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'proposals', (list) => [...list, ...fresh]))
    this.k.changed(classId)
  }

  /**
   * Approve or reject proposals. Approved ones are imported (approving a
   * proposal on a new domain also adds that domain to the class allowlist).
   */
  async resolveProposals(classId: string, approve: string[], reject: string[]): Promise<void> {
    const toImport = await this.k.repo.lock(classId, async () => {
      const meta = await this.k.repo.requireMeta(classId)
      const proposals = await this.k.repo.read(classId, 'proposals')
      const approved = proposals.filter((p) => approve.includes(p.id) && (p.status === 'proposed' || p.status === 'failed'))
      for (const p of approved) this.importing.add(p.id)
      const newDomains = approved.filter((p) => p.newDomain).map((p) => p.domain)
      if (newDomains.length) {
        await this.k.repo.writeMeta({ ...meta, trustedDomains: Array.from(new Set([...meta.trustedDomains, ...newDomains])), updatedAt: nowIso() })
      }
      await this.k.repo.write(
        classId,
        'proposals',
        proposals.map((p) =>
          approve.includes(p.id) && approved.includes(p)
            ? { ...p, status: 'approved' as const, error: undefined }
            : reject.includes(p.id) && p.status === 'proposed'
              ? { ...p, status: 'rejected' as const }
              : p
        )
      )
      return approved
    })
    this.k.changed(classId)

    try {
      for (const p of toImport) {
        try {
          const meta = await this.k.repo.requireMeta(classId)
          if (!isDomainAllowed(p.url, meta.trustedDomains)) throw userError(`${p.domain} is not on this class's trusted list.`)
          const source = await this.addUrl(classId, p.url, 'trusted', p.why)
          await this.setProposal(classId, p.id, { status: 'imported', sourceId: source.id })
        } catch (err) {
          await this.setProposal(classId, p.id, { status: 'failed', error: userMessage(err) })
        }
      }
    } finally {
      for (const p of toImport) this.importing.delete(p.id)
    }
  }

  /**
   * An approved proposal is imported by the run that approved it. One still
   * "approved" with no import under way was cut off (mint quit mid-import) and
   * would wait forever, so it becomes a failed one the learner can approve
   * again. Checked once per class per run.
   */
  async recoverInterrupted(classId: string): Promise<void> {
    if (this.recovered.has(classId)) return
    const stale = (p: SourceProposal): boolean => p.status === 'approved' && !this.importing.has(p.id)
    const found = (await this.k.repo.read(classId, 'proposals')).some(stale)
    this.recovered.add(classId)
    if (!found) return
    await this.k.repo.lock(classId, () =>
      this.k.repo.update(classId, 'proposals', (list) => list.map((p) => (stale(p) ? { ...p, status: 'failed' as const, error: 'The import was interrupted. Approve it again to retry.' } : p)))
    )
    this.k.changed(classId)
  }

  private async setProposal(classId: string, id: string, patch: Partial<SourceProposal>): Promise<void> {
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'proposals', (list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p))))
    this.k.changed(classId)
  }

  private async store(classId: string, imported: ImportedSource, origin: SourceOrigin, why?: string): Promise<SourceMeta> {
    if (!imported.sections.length) throw userError('No readable text was found in that source.')
    const doc: SourceDoc = {
      id: newId('src'),
      classId,
      kind: imported.kind,
      title: imported.title.trim().slice(0, 300) || 'Untitled source',
      origin,
      url: imported.url,
      domain: imported.domain,
      author: imported.author,
      videoId: imported.videoId,
      why,
      addedAt: nowIso(),
      wordCount: wordCount(imported.sections),
      sectionCount: imported.sections.length,
      needsTranscript: imported.needsTranscript,
      sections: imported.sections
    }
    return this.k.repo.lock(classId, async () => {
      await this.k.repo.requireMeta(classId)
      const stored = await this.k.repo.writeSource(doc, imported.original)
      const meta = toMeta(stored)
      await this.k.repo.update(classId, 'sources', (list) => [...list, meta])
      this.k.changed(classId)
      return meta
    })
  }
}

export function toMeta(doc: SourceDoc): SourceMeta {
  const { sections: _sections, ...meta } = doc
  return meta
}
