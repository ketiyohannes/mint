import { chunkIntoParts, collapseWhitespace, normalizeSections, titleFromFileName, truncateLabel, type RawBlock, type RawSection } from './normalize'
import type { ImportedSource } from './types'

/** Paragraphs per "Part N" section for unstructured text. */
const PARAGRAPHS_PER_PART = 30

function normalizeNewlines(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Strips inline markdown so block text is plain prose (highlights and
 * citations use character offsets into it). Link and image text is kept,
 * targets are dropped.
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url)
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // [text][ref]
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1') // autolinks
    .replace(/<\/?[a-z][a-z0-9-]*(\s[^>]*)?\/?>/gi, '') // inline HTML tags
    .replace(/(`+)(.+?)\1/g, (_m, _fence: string, code: string) => code.trim())
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2') // bold
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, '$1$2') // *italic*
    .replace(/(^|\W)_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, '$1$2') // _italic_ (not snake_case)
    .replace(/~~(.+?)~~/g, '$1') // strikethrough
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1') // backslash escapes
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/
const QUOTE_LINE = /^ {0,3}>\s?(.*)$/
const THEMATIC_BREAK = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)\s*$/

/** Removes YAML front matter, returning its `title:` if present. */
function stripFrontMatter(text: string): { body: string; title?: string } {
  const match = text.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/)
  if (!match) return { body: text }
  const titleLine = match[1].match(/^title:\s*(.+)$/m)
  const title = titleLine?.[1].trim().replace(/^(["'])(.*)\1$/, '$2')
  return { body: text.slice(match[0].length), ...(title ? { title } : {}) }
}

/**
 * Line-oriented markdown parser covering what study notes and READMEs use:
 * ATX and setext headings, fenced code, lists, blockquotes, tables, and
 * paragraphs. `#`/`##` start sections; deeper headings become heading blocks.
 */
function parseMarkdown(text: string): { sections: RawSection[]; firstH1?: string } {
  const lines = text.split('\n')
  const sections: RawSection[] = []
  const preamble: RawBlock[] = []
  let current: RawSection | undefined
  let firstH1: string | undefined

  // Open multi-line constructs.
  let paragraph: string[] = []
  let quote: string[] = []
  let listItem: RawBlock | null = null

  const push = (block: RawBlock): void => {
    if (!block.text.trim()) return
    if (current) current.blocks.push(block)
    else preamble.push(block)
  }
  const flushParagraph = (): void => {
    if (paragraph.length) push({ type: 'paragraph', text: stripInlineMarkdown(paragraph.join(' ')) })
    paragraph = []
  }
  const flushQuote = (): void => {
    if (quote.length) push({ type: 'quote', text: stripInlineMarkdown(quote.join(' ')) })
    quote = []
  }
  const flushList = (): void => {
    if (listItem) push({ ...listItem, text: stripInlineMarkdown(listItem.text) })
    listItem = null
  }
  const flushAll = (): void => {
    flushParagraph()
    flushQuote()
    flushList()
  }

  const heading = (level: number, raw: string): void => {
    flushAll()
    const text = collapseWhitespace(stripInlineMarkdown(raw))
    if (!text) return
    if (level <= 2) {
      if (level === 1 && firstH1 === undefined) firstH1 = text
      const label = truncateLabel(text)
      current = { label, ...(label !== text ? { title: text } : {}), blocks: [] }
      sections.push(current)
    } else {
      push({ type: 'heading', text, level })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = line.match(FENCE_OPEN)
    if (fence) {
      flushAll()
      const marker = fence[1]
      const code: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        code.push(lines[i])
        i++
      }
      push({ type: 'code', text: code.join('\n') })
      continue
    }

    if (!line.trim()) {
      flushAll()
      continue
    }

    const atx = line.match(ATX_HEADING)
    if (atx) {
      heading(atx[1].length, atx[2] ?? '')
      continue
    }

    // Setext heading: a single paragraph line underlined with === or ---.
    if (paragraph.length === 1 && SETEXT_UNDERLINE.test(line)) {
      const text = paragraph[0]
      paragraph = []
      heading(line.trim().startsWith('=') ? 1 : 2, text)
      continue
    }

    if (THEMATIC_BREAK.test(line)) {
      flushAll()
      continue
    }

    const quoteLine = line.match(QUOTE_LINE)
    if (quoteLine) {
      flushParagraph()
      flushList()
      if (quoteLine[1].trim()) quote.push(quoteLine[1])
      else flushQuote() // a bare ">" separates quoted paragraphs
      continue
    }

    if (TABLE_ROW.test(line)) {
      flushAll()
      if (!TABLE_SEPARATOR.test(line)) {
        const cells = line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => collapseWhitespace(cell))
          .filter(Boolean)
        push({ type: 'paragraph', text: stripInlineMarkdown(cells.join(' | ')) })
      }
      continue
    }

    const item = line.match(LIST_ITEM)
    if (item) {
      flushParagraph()
      flushQuote()
      flushList()
      listItem = { type: 'list-item', text: item[2] }
      continue
    }

    // Indented or lazy continuation of the open list item or quote.
    if (listItem) {
      listItem.text += ` ${line.trim()}`
      continue
    }
    if (quote.length) {
      quote.push(line.trim())
      continue
    }
    paragraph.push(line.trim())
  }
  flushAll()

  if (sections.length === 0) return { sections: chunkIntoParts(preamble, PARAGRAPHS_PER_PART), firstH1 }
  if (preamble.length) sections.unshift({ label: 'Introduction', blocks: preamble })
  return { sections, firstH1 }
}

/** Imports a markdown file. Title: front matter `title`, else the first `#` heading, else the file name. */
export function importMarkdown(text: string, fileName: string): ImportedSource {
  const { body, title: frontTitle } = stripFrontMatter(normalizeNewlines(text))
  const { sections, firstH1 } = parseMarkdown(body)
  const normalized = normalizeSections(sections)
  if (normalized.length === 0) throw new Error('This file has no text.')
  return {
    kind: 'markdown',
    title: frontTitle || firstH1 || titleFromFileName(fileName),
    sections: normalized
  }
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

/** Imports plain text: paragraphs split on blank lines, grouped into "Part N" sections. */
export function importPlainText(text: string, fileName: string): ImportedSource {
  const blocks: RawBlock[] = normalizeNewlines(text)
    .split(/\n\s*\n/)
    .map((paragraph) => ({ type: 'paragraph' as const, text: paragraph }))
    .filter((block) => block.text.trim() !== '')
  const sections = normalizeSections(chunkIntoParts(blocks, PARAGRAPHS_PER_PART))
  if (sections.length === 0) throw new Error('This file has no text.')
  return {
    kind: 'text',
    title: titleFromFileName(fileName),
    sections
  }
}
