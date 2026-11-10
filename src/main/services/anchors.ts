import type { Anchor, TextRange } from '@shared/types'
import type { Kernel } from './kernel'
import { userError } from './kernel'

type SourceAnchor = Extract<Anchor, { kind: 'source' }>

const text = (value: unknown, max: number) => String(value ?? '').slice(0, max)

function cleanRanges(ranges: unknown): TextRange[] {
  return (Array.isArray(ranges) ? ranges : [])
    .map((r) => ({ blockId: String(r?.blockId ?? ''), start: Number(r?.start), end: Number(r?.end) }))
    .filter((r) => r.blockId && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start)
    .slice(0, 50)
}

/**
 * An anchor as the renderer sent it, reduced to its known shape with bounded
 * text. It does not check that what the anchor points at exists.
 */
export function cleanAnchor(anchor: Anchor | undefined): Anchor | undefined {
  switch (anchor?.kind) {
    case 'source':
      return { kind: 'source', sourceId: text(anchor.sourceId, 80), sectionLabel: text(anchor.sectionLabel, 300), ranges: cleanRanges(anchor.ranges), quote: text(anchor.quote, 2000) }
    case 'message':
      return { kind: 'message', threadId: text(anchor.threadId, 80), messageId: text(anchor.messageId, 80), quote: text(anchor.quote, 2000) }
    case 'diagram':
      return { kind: 'diagram', explorableId: text(anchor.explorableId, 80), elementId: text(anchor.elementId, 200), label: text(anchor.label ?? anchor.elementId, 500) }
    case 'general':
      return { kind: 'general', context: anchor.context ? text(anchor.context, 2000) : undefined }
    default:
      return undefined
  }
}

/** A selection in a source, checked against the stored source: only ranges on its real blocks are kept. */
export async function validateSourceAnchor(k: Kernel, classId: string, anchor: SourceAnchor): Promise<SourceAnchor> {
  const doc = await k.repo.readSource(classId, String(anchor?.sourceId))
  const blockIds = new Set(doc.sections.flatMap((s) => s.blocks.map((b) => b.id)))
  const ranges = cleanRanges(anchor?.ranges).filter((r) => blockIds.has(r.blockId))
  if (!ranges.length) throw userError('That selection could not be located in the source.')
  return { kind: 'source', sourceId: doc.id, sectionLabel: text(anchor.sectionLabel, 300), ranges, quote: text(anchor.quote, 2000) }
}
