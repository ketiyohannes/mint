import type { Contents, ContentsItem, SourceRef } from '@shared/types'
import { slugify } from '../store/fsutil'
import { matchSection, type SourceIndex } from './curriculum'

/** The list as the model wrote it (already schema-validated). */
export interface RawContents {
  summary: string
  items: { title: string; summary: string; sources: { sourceId: string; section: string }[] }[]
}

/** More than this is a table of contents, not a list to pick from. */
const MAX_ITEMS = 60
const MAX_REFS = 3

const oneLine = (s: string, max: number) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

/**
 * Turn a model-written list into the class's contents. Code guarantees what
 * the rest of the app relies on:
 *  - every item has a title, and no title appears twice
 *  - ids are unique, and an item keeps its id across refreshes while its
 *    title stays (the chat that explains it is found by that id)
 *  - source references point at real sources and sections
 */
export function validateContents(raw: RawContents, sources: SourceIndex[], previous: Contents | null): Contents {
  const previousIds = new Map((previous?.items ?? []).map((i) => [i.title.toLowerCase(), i.id]))
  const byId = new Map(sources.map((s) => [s.meta.id, s]))
  const usedIds = new Set<string>()
  const seenTitles = new Set<string>()
  const items: ContentsItem[] = []

  for (const r of raw.items) {
    if (items.length >= MAX_ITEMS) break
    const title = oneLine(r.title, 120)
    const key = title.toLowerCase()
    if (!title || seenTitles.has(key)) continue
    seenTitles.add(key)

    let id = previousIds.get(key) ?? (slugify(title, 40) || 'item')
    if (usedIds.has(id)) {
      let n = 2
      while (usedIds.has(`${id}-${n}`)) n++
      id = `${id}-${n}`
    }
    usedIds.add(id)

    const refs: SourceRef[] = []
    for (const ref of r.sources ?? []) {
      const src = byId.get(String(ref.sourceId ?? '').trim())
      if (!src) continue
      // A section the material does not have points at its start instead of nowhere.
      const section = matchSection(ref.section, src.sectionLabels) ?? src.sectionLabels[0] ?? ''
      if (!refs.some((x) => x.sourceId === src.meta.id && x.section === section)) refs.push({ sourceId: src.meta.id, section })
      if (refs.length >= MAX_REFS) break
    }
    items.push({ id, title, summary: oneLine(r.summary, 400), sources: refs })
  }

  return { updatedAt: new Date().toISOString(), summary: oneLine(raw.summary, 600), items }
}
