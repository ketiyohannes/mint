import type { TextRange } from '@shared/types'

/**
 * Selection <-> anchor mapping for the reader. Each rendered block is an
 * element with `data-block-id`; offsets are character offsets into that
 * block's plain text, so anchors survive re-rendering and highlight changes.
 */

export function blockElementOf(node: Node | null): HTMLElement | null {
  let el: Node | null = node
  while (el && !(el instanceof HTMLElement && el.dataset.blockId)) el = el.parentNode
  return el as HTMLElement | null
}

/** Character offset of (node, offset) within the visible text of `root`. */
export function textOffset(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange()
  range.setStart(root, 0)
  try {
    range.setEnd(node, offset)
  } catch {
    return 0
  }
  return visibleText(range.cloneContents()).length
}

/** Text nodes inside elements marked `data-ignore-text` (pins, timestamps) are not part of the block text. */
function acceptVisible(n: Node): number {
  let p = n.parentElement
  while (p) {
    if (p.dataset?.ignoreText !== undefined) return NodeFilter.FILTER_REJECT
    if (p.dataset?.blockId) break
    p = p.parentElement
  }
  return NodeFilter.FILTER_ACCEPT
}

function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return acceptVisible(node) === NodeFilter.FILTER_ACCEPT ? (node.textContent ?? '') : ''
  if (node instanceof HTMLElement && node.dataset.ignoreText !== undefined) return ''
  return Array.from(node.childNodes).map(visibleText).join('')
}

export interface SelectionAnchor {
  ranges: TextRange[]
  quote: string
  rect: DOMRect
  sectionLabel: string
}

/** Convert the current DOM selection inside `container` to block ranges. */
export function selectionToAnchor(container: HTMLElement, blockText: (blockId: string) => string | undefined): SelectionAnchor | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return null
  const startBlock = blockElementOf(range.startContainer)
  const endBlock = blockElementOf(range.endContainer)
  if (!startBlock || !endBlock) return null

  const blocks = Array.from(container.querySelectorAll<HTMLElement>('[data-block-id]'))
  const from = blocks.indexOf(startBlock)
  const to = blocks.indexOf(endBlock)
  if (from < 0 || to < 0 || to < from) return null

  const ranges: TextRange[] = []
  for (let i = from; i <= to; i++) {
    const el = blocks[i]
    const id = el.dataset.blockId!
    const text = blockText(id) ?? ''
    const start = i === from ? textOffset(el, range.startContainer, range.startOffset) : 0
    const end = i === to ? textOffset(el, range.endContainer, range.endOffset) : text.length
    const s = Math.max(0, Math.min(start, text.length))
    const e = Math.max(0, Math.min(end, text.length))
    if (e > s) ranges.push({ blockId: id, start: s, end: e })
    if (ranges.length >= 50) break
  }
  if (!ranges.length) return null
  const quote = ranges.map((r) => (blockText(r.blockId) ?? '').slice(r.start, r.end)).join(' ').replace(/\s+/g, ' ').trim()
  if (!quote) return null
  const sectionLabel = startBlock.closest<HTMLElement>('[data-section-label]')?.dataset.sectionLabel ?? ''
  return { ranges, quote: quote.slice(0, 2000), rect: range.getBoundingClientRect(), sectionLabel }
}

export interface Mark {
  start: number
  end: number
  kind: 'highlight' | 'note' | 'thread' | 'flash-quote'
  id: string
}

export interface Segment {
  text: string
  marks: Mark[]
}

/** Split block text into segments so overlapping marks render as nested-free spans. */
export function segmentText(text: string, marks: Mark[]): Segment[] {
  const cuts = new Set<number>([0, text.length])
  for (const m of marks) {
    cuts.add(Math.max(0, Math.min(text.length, m.start)))
    cuts.add(Math.max(0, Math.min(text.length, m.end)))
  }
  const points = [...cuts].sort((a, b) => a - b)
  const out: Segment[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (b <= a) continue
    out.push({ text: text.slice(a, b), marks: marks.filter((m) => m.start <= a && m.end >= b) })
  }
  return out
}

/** Locate a short quote inside block texts (whitespace/case/punctuation tolerant). */
export function findQuote(blocks: { id: string; text: string }[], quote: string): { blockId: string; start: number; end: number } | null {
  const q = normalize(quote)
  if (!q) return null
  for (const b of blocks) {
    const { norm, map } = normalizeWithMap(b.text)
    const idx = norm.indexOf(q)
    if (idx >= 0) return { blockId: b.id, start: map[idx], end: map[Math.min(idx + q.length - 1, map.length - 1)] + 1 }
  }
  // Fall back to the longest prefix of the quote that matches.
  const words = q.split(' ')
  for (let n = words.length - 1; n >= 3; n--) {
    const part = words.slice(0, n).join(' ')
    for (const b of blocks) {
      const { norm, map } = normalizeWithMap(b.text)
      const idx = norm.indexOf(part)
      if (idx >= 0) return { blockId: b.id, start: map[idx], end: map[Math.min(idx + part.length - 1, map.length - 1)] + 1 }
    }
  }
  return null
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”"‘’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = ''
  const map: number[] = []
  let lastSpace = true
  for (let i = 0; i < s.length; i++) {
    const ch = s[i].toLowerCase()
    if (/[“”"‘’'`]/.test(ch)) continue
    if (/[\p{L}\p{N}]/u.test(ch)) {
      norm += ch
      map.push(i)
      lastSpace = false
    } else if (!lastSpace) {
      norm += ' '
      map.push(i)
      lastSpace = true
    }
  }
  return { norm: norm.trimEnd(), map }
}

/**
 * Map a quote (selected on a rendered PDF page, say) back to block ranges.
 * Matching is whitespace/case/punctuation tolerant and may span blocks; when
 * the full quote is not found, the longest matching prefix (3+ words) is used.
 */
export function quoteToRanges(blocks: { id: string; text: string }[], quote: string): TextRange[] {
  const q = normalize(quote)
  if (!q) return []
  // One normalized string over all blocks, with a map back to (block, offset).
  let all = ''
  const owner: { block: number; offset: number }[] = []
  blocks.forEach((b, bi) => {
    const { norm, map } = normalizeWithMap(b.text)
    if (!norm) return
    if (all && !all.endsWith(' ')) {
      all += ' '
      owner.push({ block: bi, offset: -1 })
    }
    for (let i = 0; i < norm.length; i++) owner.push({ block: bi, offset: map[i] })
    all += norm
  })
  let idx = all.indexOf(q)
  let len = q.length
  if (idx < 0) {
    const words = q.split(' ')
    for (let n = words.length - 1; n >= 3 && idx < 0; n--) {
      const part = words.slice(0, n).join(' ')
      idx = all.indexOf(part)
      len = part.length
    }
  }
  if (idx < 0) return []
  const ranges: TextRange[] = []
  for (let i = idx; i < idx + len; i++) {
    const o = owner[i]
    if (!o || o.offset < 0) continue
    const id = blocks[o.block].id
    const last = ranges[ranges.length - 1]
    if (last && last.blockId === id) last.end = o.offset + 1
    else ranges.push({ blockId: id, start: o.offset, end: o.offset + 1 })
  }
  return ranges.slice(0, 50)
}

/** Find a quote in the rendered text under `root` and return a DOM Range over it (for CSS highlights). */
export function rangeForQuote(root: HTMLElement, quote: string): Range | null {
  const q = normalize(quote)
  if (!q) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let norm = ''
  const map: { node: Text; offset: number }[] = []
  let lastSpace = true
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const t = n.data
    for (let i = 0; i < t.length; i++) {
      const ch = t[i].toLowerCase()
      if (/[“”"‘’'`]/.test(ch)) continue
      if (/[\p{L}\p{N}]/u.test(ch)) {
        norm += ch
        map.push({ node: n, offset: i })
        lastSpace = false
      } else if (!lastSpace) {
        norm += ' '
        map.push({ node: n, offset: i })
        lastSpace = true
      }
    }
    // Text layer spans are separate words/lines: treat a node boundary as a space.
    if (!lastSpace) {
      norm += ' '
      map.push({ node: n, offset: t.length })
      lastSpace = true
    }
  }
  let idx = norm.indexOf(q)
  let len = q.length
  if (idx < 0) {
    const words = q.split(' ')
    for (let n = words.length - 1; n >= 3 && idx < 0; n--) {
      const part = words.slice(0, n).join(' ')
      idx = norm.indexOf(part)
      len = part.length
    }
  }
  if (idx < 0) return null
  const a = map[idx]
  const b = map[Math.min(idx + len - 1, map.length - 1)]
  const range = document.createRange()
  try {
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, Math.min(b.node.data.length, b.offset + 1))
  } catch {
    return null
  }
  return range
}
