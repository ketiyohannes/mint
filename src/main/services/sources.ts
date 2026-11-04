import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SourceDoc, SourceMeta, SourceOrigin, SourceProposal } from '@shared/types'
import { domainOf, importFile, importUrl, isDomainAllowed, normalizeSections, parseYouTubeId, transcriptFromText, wordCount, type ImportedSource } from '../sources'
import { expandPaths } from '../sources/expand'
import { newId, nowIso } from '../store/fsutil'
import { proposeSources } from '../jobs'
import type { Kernel } from './kernel'
import { userError, userMessage } from './kernel'

export class SourceService {
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
  async setTranscript(classId: string, sourceId: string, text: string): Promise<SourceMeta> {
    if (!text.trim()) throw userError('Paste the transcript text first.')
    return this.k.repo.lock(classId, async () => {
      const doc = await this.k.repo.readSource(classId, sourceId)
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

  /** Ask the agent for trusted public sources (allowlisted domains only). */
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
      const newDomains = approved.filter((p) => p.newDomain).map((p) => p.domain)
      if (newDomains.length) {
        await this.k.repo.writeMeta({ ...meta, trustedDomains: Array.from(new Set([...meta.trustedDomains, ...newDomains])), updatedAt: nowIso() })
      }
      await this.k.repo.write(
        classId,
        'proposals',
        proposals.map((p) =>
          approve.includes(p.id) && approved.includes(p) ? { ...p, status: 'approved' as const, error: undefined } : reject.includes(p.id) && p.status === 'proposed' ? { ...p, status: 'rejected' as const } : p
        )
      )
      return approved
    })
    this.k.changed(classId)

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
