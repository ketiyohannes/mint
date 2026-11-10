import { extractText, getDocumentProxy, getMeta } from 'unpdf'
import { normalizeSections, titleFromFileName, type RawBlock, type RawSection } from './normalize'
import type { ImportedSource } from './types'

const NO_TEXT_MESSAGE = "This PDF has no selectable text (it may be a scan). Try an OCR'd copy."

/** Producer-generated placeholder titles that say nothing about the document. */
const MEANINGLESS_TITLE = /^(untitled|unknown|none|null|document\d*|slide\s*\d*|presentation\d*|microsoft (word|powerpoint)\b.*|.*\.(pdf|docx?|pptx?|tex|indd|odt|rtf|txt))$/i

function meaningfulTitle(raw: string | undefined): string | undefined {
  const title = raw?.replace(/\s+/g, ' ').trim()
  if (!title || title.length < 3 || MEANINGLESS_TITLE.test(title)) return undefined
  return title
}

const BULLET = /^([•◦▪‣∙·●○■□–—*-]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/
const SENTENCE_END = /[.!?:;]["'”’)\]]*$/
const STARTS_LIKE_SENTENCE = /^["'“‘(\[]?[A-Z0-9]/

/** Joins a wrapped line onto the paragraph so far, undoing end-of-line hyphenation. */
function joinLine(paragraph: string, line: string): string {
  if (!paragraph) return line
  // "infor-" + "mation" -> "information"; keep real hyphens before capitals ("Jean-" + "Paul").
  if (/[a-z]-$/.test(paragraph) && /^[a-z]/.test(line)) return paragraph.slice(0, -1) + line
  return `${paragraph} ${line}`
}

/** Typical full line length on a page: lines noticeably shorter likely end a paragraph. */
function typicalLineLength(lines: string[]): number {
  const lengths = lines
    .map((l) => l.length)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
  if (lengths.length < 3) return Infinity
  return lengths[Math.floor(lengths.length * 0.75)]
}

/**
 * Rebuilds paragraphs from a page's text lines. PDF text has no paragraph
 * markup, so we break on blank lines, on bullet markers, and where a line
 * ends a sentence, is shorter than a full line, and the next one starts like
 * a new sentence.
 */
export function pageTextToBlocks(pageText: string): RawBlock[] {
  const lines = pageText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())

  // Drop a bare page number at the top or bottom of the page.
  const firstContent = lines.findIndex((l) => l !== '')
  const lastContent = lines.findLastIndex((l) => l !== '')
  for (const idx of [firstContent, lastContent]) {
    if (idx >= 0 && /^(page\s+)?\d{1,4}$/i.test(lines[idx])) lines[idx] = ''
  }

  const fullLine = typicalLineLength(lines)
  const blocks: RawBlock[] = []
  let current: RawBlock | null = null
  let previous = ''

  const flush = (): void => {
    if (current && current.text.trim()) blocks.push(current)
    current = null
  }

  for (const line of lines) {
    if (!line) {
      flush()
      previous = ''
      continue
    }

    const bullet = line.match(BULLET)
    const paragraphEnded = previous !== '' && SENTENCE_END.test(previous) && STARTS_LIKE_SENTENCE.test(line) && previous.length < fullLine * 0.85

    if (bullet || paragraphEnded || !current) {
      flush()
      current = bullet ? { type: 'list-item', text: line.slice(bullet[0].length) } : { type: 'paragraph', text: line }
    } else {
      current.text = joinLine(current.text, line)
    }
    previous = line
  }
  flush()
  return blocks
}

/** Imports a PDF: one section per page labeled `p. N`. */
export async function importPdf(bytes: Uint8Array, fileName: string): Promise<ImportedSource> {
  // pdf.js may transfer (detach) the buffer it is given; hand it a copy so the
  // caller's bytes stay intact for `original`.
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (/password/i.test(reason)) throw new Error('This PDF is password-protected. Remove the password and try again.')
    throw new Error(`This file could not be read as a PDF (${reason}).`)
  }

  try {
    const { text: pages } = await extractText(pdf, { mergePages: false })

    let info: { Title?: string; Author?: string } = {}
    try {
      info = (await getMeta(pdf)).info
    } catch {
      // Metadata is optional; a broken Info dictionary should not fail the import.
    }

    const sections: RawSection[] = pages.map((pageText, i) => ({
      label: `p. ${i + 1}`,
      blocks: pageTextToBlocks(pageText)
    }))
    const normalized = normalizeSections(sections)
    if (normalized.length === 0) throw new Error(NO_TEXT_MESSAGE)

    const author = info.Author?.replace(/\s+/g, ' ').trim()
    return {
      kind: 'pdf',
      title: meaningfulTitle(info.Title) ?? titleFromFileName(fileName),
      ...(author ? { author } : {}),
      sections: normalized,
      original: { bytes, ext: 'pdf' }
    }
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined)
  }
}
