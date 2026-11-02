import type { Anchor, Annotation, GlossaryTerm, NoteDoc } from '@shared/types'
import { findTopic } from '@shared/curriculum'
import { checkGlossaryTerm, draftReference, reviewNote } from '../jobs'
import { newId, nowIso } from '../store/fsutil'
import type { Kernel } from './kernel'
import { userError } from './kernel'
import { appendRecords } from './records'

/** Notes, reference sheets, annotations (highlights + sticky notes), glossary, and records. */
export class NotebookService {
  constructor(private readonly k: Kernel) {}

  // --- annotations -------------------------------------------------------

  async createAnnotation(classId: string, anchor: Extract<Anchor, { kind: 'source' }>, kind: 'highlight' | 'note', text?: string): Promise<void> {
    if (anchor?.kind !== 'source' || !anchor.ranges?.length) throw userError('Select some text first.')
    const now = nowIso()
    const a: Annotation = {
      id: newId('ann'),
      classId,
      anchor: { kind: 'source', sourceId: anchor.sourceId, sectionLabel: anchor.sectionLabel, ranges: anchor.ranges.slice(0, 50), quote: anchor.quote.slice(0, 2000) },
      kind: kind === 'note' ? 'note' : 'highlight',
      text: text?.slice(0, 8000),
      createdAt: now,
      updatedAt: now
    }
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'annotations', (list) => [...list, a]))
    this.k.changed(classId)
  }

  async updateAnnotation(classId: string, id: string, text: string): Promise<void> {
    await this.k.repo.lock(classId, () =>
      this.k.repo.update(classId, 'annotations', (list) => list.map((a) => (a.id === id ? { ...a, text: text.slice(0, 8000), updatedAt: nowIso() } : a)))
    )
    this.k.changed(classId)
  }

  async removeAnnotation(classId: string, id: string): Promise<void> {
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'annotations', (list) => list.filter((a) => a.id !== id)))
    this.k.changed(classId)
  }

  // --- notes and reference sheets ----------------------------------------

  async saveNote(classId: string, input: Pick<NoteDoc, 'kind' | 'title' | 'body'> & { id?: string }): Promise<NoteDoc> {
    const title = input.title.trim().slice(0, 160) || 'Untitled'
    const body = String(input.body ?? '').slice(0, 200_000)
    const kind = input.kind === 'reference' ? 'reference' : 'note'
    const note = await this.k.repo.lock(classId, async () => {
      let saved: NoteDoc | undefined
      await this.k.repo.update(classId, 'notes', (list) => {
        const existing = input.id ? list.find((n) => n.id === input.id) : undefined
        if (existing) {
          // Once the learner edits a tutor draft, it is theirs.
          saved = { ...existing, title, body, kind, authoredBy: existing.body !== body ? 'learner' : existing.authoredBy, updatedAt: nowIso() }
          return list.map((n) => (n.id === existing.id ? saved! : n))
        }
        const now = nowIso()
        saved = { id: newId('note'), classId, kind, title, body, authoredBy: 'learner', createdAt: now, updatedAt: now }
        return [...list, saved]
      })
      return saved!
    })
    this.k.changed(classId)
    return note
  }

  async removeNote(classId: string, id: string): Promise<void> {
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'notes', (list) => list.filter((n) => n.id !== id)))
    this.k.changed(classId)
  }

  /**
   * Reference sheets: the tutor drafts only while the learner is still at a
   * low independence level. Later the learner writes and the tutor reviews.
   */
  async draftReference(classId: string, topicId: string | null): Promise<NoteDoc> {
    const ctx = await this.k.context(classId)
    if (ctx.independence.level >= 2) throw userError('At your independence level you write reference sheets yourself, then ask the tutor to review them.')
    const topic = topicId ? (findTopic(ctx.curriculum, topicId) ?? null) : null
    const draft = await this.k.job(classId, 'Drafting a reference sheet', async () => draftReference({ runtime: await this.k.runtime(), ctx }, topic))
    const now = nowIso()
    const note: NoteDoc = { id: newId('note'), classId, kind: 'reference', title: draft.title.trim().slice(0, 160) || 'Reference', body: draft.body, authoredBy: 'tutor-draft', createdAt: now, updatedAt: now }
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'notes', (list) => [...list, note]))
    this.k.changed(classId)
    return note
  }

  async review(classId: string, noteId: string, streamId: string): Promise<string> {
    const note = (await this.k.repo.read(classId, 'notes')).find((n) => n.id === noteId)
    if (!note) throw userError('That note no longer exists.')
    if (!note.body.trim()) throw userError('Write something first, then ask for a review.')
    const ctx = await this.k.context(classId)
    try {
      const text = await reviewNote({ runtime: await this.k.runtime(), ctx }, note, (delta) => this.k.emitter.stream({ streamId, delta }))
      this.k.emitter.stream({ streamId, done: true })
      return text
    } catch (err) {
      this.k.emitter.stream({ streamId, done: true, error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  /** Promote a sticky (Ask thread) into a learner note. */
  async fromThread(classId: string, threadId: string): Promise<NoteDoc> {
    const thread = (await this.k.repo.read(classId, 'threads')).find((t) => t.id === threadId)
    if (!thread) throw userError('That thread no longer exists.')
    const quote = thread.anchor.kind === 'source' || thread.anchor.kind === 'message' ? `> ${thread.anchor.quote}\n\n` : ''
    const body = `${quote}${thread.messages.map((m) => `**${m.role === 'user' ? 'Me' : 'Tutor'}:** ${m.text}`).join('\n\n')}\n\n## In my own words\n\n`
    return this.saveNote(classId, { kind: 'note', title: thread.title, body })
  }

  // --- glossary ------------------------------------------------------------

  async proposeTerm(classId: string, term: string, definition: string, anchor?: Anchor): Promise<{ accepted: boolean; feedback: string; term?: GlossaryTerm }> {
    const name = term.trim().slice(0, 120)
    const def = definition.trim().slice(0, 1200)
    if (!name || !def) throw userError('Give the term and your own definition.')
    const ctx = await this.k.context(classId)
    if (ctx.glossary.some((g) => g.term.toLowerCase() === name.toLowerCase())) throw userError(`"${name}" is already in your glossary.`)
    const context = anchor?.kind === 'source' ? `"${anchor.quote}" (${anchor.sectionLabel})` : ''
    const check = await this.k.job(classId, 'Checking your definition', async () => checkGlossaryTerm({ runtime: await this.k.runtime(), ctx }, name, def, context))
    if (!check.accepted) return { accepted: false, feedback: check.feedback }
    const now = nowIso()
    const entry: GlossaryTerm = {
      id: newId('term'),
      term: name,
      definition: check.definition.trim() || def,
      avoid: check.avoid.map((a) => a.trim()).filter(Boolean).slice(0, 6),
      sourceRef: anchor?.kind === 'source' ? { sourceId: anchor.sourceId, section: anchor.sectionLabel } : undefined,
      addedAt: now,
      updatedAt: now
    }
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'glossary', (list) => [...list, entry]))
    this.k.changed(classId)
    return { accepted: true, feedback: check.feedback, term: entry }
  }

  async updateTerm(classId: string, id: string, patch: Partial<Pick<GlossaryTerm, 'term' | 'definition' | 'avoid'>>): Promise<void> {
    await this.k.repo.lock(classId, () =>
      this.k.repo.update(classId, 'glossary', (list) =>
        list.map((g) =>
          g.id === id
            ? {
                ...g,
                term: patch.term?.trim().slice(0, 120) || g.term,
                definition: patch.definition?.trim().slice(0, 1200) || g.definition,
                avoid: patch.avoid ? patch.avoid.map((a) => a.trim()).filter(Boolean).slice(0, 6) : g.avoid,
                updatedAt: nowIso()
              }
            : g
        )
      )
    )
    this.k.changed(classId)
  }

  async removeTerm(classId: string, id: string): Promise<void> {
    await this.k.repo.lock(classId, () => this.k.repo.update(classId, 'glossary', (list) => list.filter((g) => g.id !== id)))
    this.k.changed(classId)
  }

  // --- learning records ----------------------------------------------------

  /** Supersede a record with a corrected understanding (history is kept). */
  async supersede(classId: string, recordId: string, title: string, body: string): Promise<void> {
    if (!title.trim() || !body.trim()) throw userError('Give the new record a title and a description.')
    await this.k.repo.lock(classId, async () => {
      const records = await this.k.repo.read(classId, 'records')
      const old = records.find((r) => r.id === recordId)
      if (!old) throw userError('That record no longer exists.')
      if (old.supersededBy) throw userError('That record was already superseded.')
      const [created] = await appendRecords(this.k, classId, [{ title, body, evidence: `Supersedes LR-${String(old.number).padStart(4, '0')}.`, kind: old.kind, topicId: old.topicId }])
      await this.k.repo.update(classId, 'records', (list) => list.map((r) => (r.id === recordId ? { ...r, supersededBy: created.id } : r)))
    })
    this.k.changed(classId)
  }
}
