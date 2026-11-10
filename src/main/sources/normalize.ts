import type { BlockType, SourceBlock, SourceSection } from '@shared/types'

/**
 * Importer-facing shapes. Importers produce these loosely (no ids, messy
 * whitespace, possibly empty entries) and `normalizeSections` turns them into
 * the canonical `SourceSection[]` stored in the index.
 */
export interface RawBlock {
  type: BlockType
  text: string
  level?: number
  t?: number
}

export interface RawSection {
  label: string
  title?: string
  t?: number
  blocks: RawBlock[]
}

/** Paragraphs longer than this are split at sentence boundaries. */
const MAX_PARAGRAPH_CHARS = 1200
const MAX_LABEL_CHARS = 60

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' })

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Code keeps its line structure and indentation; only line endings and edge blank lines are cleaned. */
function cleanCode(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

/** Truncates a heading to a short citation label, preferring a word boundary. */
export function truncateLabel(text: string, max = MAX_LABEL_CHARS): string {
  const clean = collapseWhitespace(text)
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** Seconds to `mm:ss`, or `h:mm:ss` from one hour on. */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/**
 * Splits a long paragraph into chunks of at most `max` characters, breaking
 * between sentences. A single sentence longer than `max` is broken between words.
 */
export function splitLongText(text: string, max = MAX_PARAGRAPH_CHARS): string[] {
  if (text.length <= max) return [text]

  const pieces: string[] = []
  for (const { segment } of sentenceSegmenter.segment(text)) {
    const sentence = segment.trim()
    if (!sentence) continue
    if (sentence.length <= max) {
      pieces.push(sentence)
      continue
    }
    // Run-on "sentence" (no punctuation, e.g. auto-captions): fall back to words.
    let current = ''
    for (const word of sentence.split(' ')) {
      if (current && current.length + 1 + word.length > max) {
        pieces.push(current)
        current = word
      } else {
        current = current ? `${current} ${word}` : word
      }
    }
    if (current) pieces.push(current)
  }

  // Greedily pack sentences into chunks, aiming for evenly sized chunks so the
  // last one is not a tiny remainder.
  const targetChunks = Math.ceil(text.length / max)
  const target = Math.min(max, Math.ceil(text.length / targetChunks))
  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece
    if (current && (candidate.length > max || current.length >= target)) {
      chunks.push(current)
      current = piece
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeBlock(raw: RawBlock): Omit<SourceBlock, 'id'>[] {
  if (raw.type === 'code') {
    const text = cleanCode(raw.text)
    return text.trim() ? [{ type: 'code', text }] : []
  }

  const text = collapseWhitespace(raw.text)
  if (!text) return []

  const base: Omit<SourceBlock, 'id' | 'text'> = { type: raw.type }
  if (raw.type === 'heading') {
    base.level = Math.min(6, Math.max(1, Math.round(isFiniteNumber(raw.level) ? raw.level : 3)))
  }
  if (isFiniteNumber(raw.t)) base.t = Math.max(0, raw.t)

  if (raw.type === 'paragraph') {
    return splitLongText(text).map((chunk) => ({ ...base, text: chunk }))
  }
  return [{ ...base, text }]
}

/**
 * Canonicalizes importer output: assigns ids (`s{i}`, `s{i}b{j}`), cleans
 * whitespace, splits overlong paragraphs, and drops empty blocks and sections.
 * Ids are assigned after dropping, so they are always contiguous. Labels are
 * what citations point at, so a repeated one gets a number: "Exercises (2)".
 */
export function normalizeSections(sections: RawSection[]): SourceSection[] {
  const out: SourceSection[] = []
  const taken = new Set<string>()
  for (const raw of sections) {
    const blocks = raw.blocks.flatMap(normalizeBlock)
    if (blocks.length === 0) continue

    const i = out.length
    const heading = collapseWhitespace(raw.label) || `Section ${i + 1}`
    let label = heading
    for (let n = 2; taken.has(label); n++) label = `${heading} (${n})`
    taken.add(label)
    const section: SourceSection = {
      id: `s${i}`,
      label,
      blocks: blocks.map((block, j) => ({ id: `s${i}b${j}`, ...block }))
    }
    const title = raw.title ? collapseWhitespace(raw.title) : ''
    if (title) section.title = title
    if (isFiniteNumber(raw.t)) section.t = Math.max(0, raw.t)
    out.push(section)
  }
  return out
}

/**
 * Splits a flat list of blocks into sections of `size` blocks labeled
 * "Part 1", "Part 2", ... Used when a document has no structural headings.
 */
export function chunkIntoParts(blocks: RawBlock[], size = 30): RawSection[] {
  const sections: RawSection[] = []
  for (let i = 0; i < blocks.length; i += size) {
    sections.push({ label: `Part ${sections.length + 1}`, blocks: blocks.slice(i, i + size) })
  }
  return sections
}

export function wordCount(sections: SourceSection[]): number {
  let count = 0
  for (const section of sections) {
    for (const block of section.blocks) {
      const words = block.text.match(/\S+/g)
      if (words) count += words.length
    }
  }
  return count
}

/** A fence longer than any backtick run inside the code, so the code cannot close it early. */
function fenceFor(code: string): string {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longestRun + 1))
}

function renderBlock(block: SourceBlock): string {
  const ref = `^${block.id}`
  switch (block.type) {
    case 'heading':
      return `### ${block.text}  ${ref}`
    case 'list-item':
      return `- ${block.text}  ${ref}`
    case 'quote':
      return `> ${block.text}  ${ref}`
    case 'code': {
      const fence = fenceFor(block.text)
      return `${fence}\n${block.text}\n${fence}\n${ref}`
    }
    case 'cue':
      return isFiniteNumber(block.t) ? `[${formatTimestamp(block.t)}] ${block.text}  ${ref}` : `${block.text}  ${ref}`
    case 'paragraph':
      return `${block.text}  ${ref}`
  }
}

/**
 * Renders a source as the markdown file agents read with Read/Grep. Every
 * block ends with `^blockId` so agents can cite exact blocks, and each block
 * sits on its own line so a Grep hit always carries its id.
 */
export function toAgentMarkdown(doc: { id: string; title: string; kind: string; url?: string; sections: SourceSection[] }): string {
  const meta = [`source-id: ${doc.id}`, `kind: ${doc.kind}`]
  if (doc.url) meta.push(`url: ${doc.url}`)

  const parts = [`# ${collapseWhitespace(doc.title)}\n${meta.join(' · ')}`]
  for (const section of doc.sections) {
    const heading = section.title && section.title !== section.label ? `## [${section.label}] ${section.title}` : `## [${section.label}]`
    parts.push([heading, ...section.blocks.map(renderBlock)].join('\n'))
  }
  return `${parts.join('\n\n')}\n`
}

/** File name without directory or extension, for use as a fallback title. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  const stem = base.replace(/\.[^.]+$/, '')
  return collapseWhitespace(stem.replace(/[_]+/g, ' ')) || base
}
