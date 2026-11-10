import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { splitDirectives, type Directive } from '@shared/directives'

const marked = new Marked({ gfm: true, breaks: false })

export interface RenderedMarkdown {
  html: string
  directives: Directive[]
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export interface MathItem {
  tex: string
  display: boolean
}

/** Fenced blocks (closed or still streaming) and inline code spans. */
const CODE = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)(?!`)[^\n]+?(?<!`)\2(?!`)/g

/**
 * Swap formulas for inert @@Mn@@ tokens, collecting them in `math`. Code is
 * left as written: `$x^2$` in a code span, or "${a}${b}" in a fenced block, is
 * text. Escaped dollars and prices ("$5 and $10") are left alone too.
 */
export function extractMath(text: string, math: MathItem[]): string {
  const token = (tex: string, display: boolean) => {
    math.push({ tex, display })
    return `@@M${math.length - 1}@@`
  }
  // Display math first, then inline math.
  const swap = (part: string) =>
    part
      .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => token(tex, true))
      .replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_m, pre: string, tex: string) => `${pre}${token(tex, false)}`)
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => token(tex, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => token(tex, false))
  let out = ''
  let last = 0
  for (const m of text.matchAll(CODE)) {
    const at = m.index ?? 0
    out += swap(text.slice(last, at)) + m[0]
    last = at + m[0].length
  }
  return out + swap(text.slice(last))
}

/** Added after each code block; RichText copies the block when it is pressed. */
const COPY_BUTTON = '<button type="button" class="code-copy" title="Copy code" aria-label="Copy code" data-testid="code-copy">Copy</button>'

/**
 * Render tutor markdown safely:
 *  1. directives and math are swapped for inert tokens,
 *  2. markdown is rendered and sanitized with DOMPurify,
 *  3. tokens are replaced with escaped chip/KaTeX markup.
 * Model text never reaches innerHTML unsanitized.
 */
export function renderMarkdown(text: string, labelForSource?: (sourceId: string) => string | undefined, opts: { inline?: boolean } = {}): RenderedMarkdown {
  const directives: Directive[] = []
  const math: MathItem[] = []
  const arrays: string[] = []

  // ```array blocks (JSON, 1-D or 2-D) become cell grids. Pulled out before
  // anything else so their brackets are never read as math or directives.
  text = text.replace(/```array[^\n]*\n([\s\S]*?)```/g, (whole, body: string) => {
    const html = renderArray(body)
    if (!html) return whole
    arrays.push(html)
    return `\n\n@@A${arrays.length - 1}@@\n\n`
  })

  let prepared = splitDirectives(text)
    .map((seg) => {
      if (seg.kind === 'text') return seg.text
      directives.push(seg.directive)
      return `@@D${directives.length - 1}@@`
    })
    .join('')

  prepared = extractMath(prepared, math)

  // Inline text (option labels, titles) renders without paragraph wrappers.
  const raw = (opts.inline ? marked.parseInline(prepared, { async: false }) : marked.parse(prepared, { async: false })) as string
  // No class, id or data-* from the model: with them its HTML could dress up as the app's own controls
  // (chips, KaTeX, arrays and copy buttons are added after this, so they keep theirs).
  let html: string = String(DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style', 'class', 'id'], ALLOW_DATA_ATTR: false }))
  if (!opts.inline) html = html.replace(/<pre>[\s\S]*?<\/pre>/g, (pre) => `<div class="code-block">${pre}${COPY_BUTTON}</div>`)

  html = html.replace(/@@M(\d+)@@/g, (_m, i: string) => {
    const item = math[Number(i)]
    return item ? renderMath(item.tex, item.display) : ''
  })
  html = html.replace(/(?:<p>)?@@A(\d+)@@(?:<\/p>)?/g, (_m, i: string) => arrays[Number(i)] ?? '')
  html = html.replace(/@@D(\d+)@@/g, (_m, i: string) => {
    const d = directives[Number(i)]
    if (!d) return ''
    if (d.type === 'offer') {
      const label = { quiz: 'Quiz me', code: 'Code exercise', diagram: 'Draw it' }[d.tool]
      return `<button type="button" class="offer-chip" data-dir="${i}" title="${escapeHtml(d.arg)}">▸ ${label}${d.arg ? `: ${escapeHtml(d.arg.length > 60 ? `${d.arg.slice(0, 57)}…` : d.arg)}` : ''}</button>`
    }
    if (d.type === 'cite') {
      const title = labelForSource?.(d.sourceId)
      const label = d.section || title || 'source'
      const tip = `${title ?? 'Source'}${d.section ? ` · ${d.section}` : ''}${d.quote ? ` · “${d.quote}”` : ''}`
      return `<button type="button" class="cite-chip" data-dir="${i}" title="${escapeHtml(tip)}">↗ ${escapeHtml(label)}</button>`
    }
    if (d.type === 'highlight') return `<button type="button" class="dir-chip" data-dir="${i}" title="Show on the diagram">◎ ${escapeHtml(d.elementId)}</button>`
    return `<button type="button" class="dir-chip" data-dir="${i}" title="Set the slider">⇄ ${escapeHtml(d.paramId)} = ${d.value}</button>`
  })
  return { html, directives }
}

/** The one place formulas become HTML (chat, lessons, quizzes, notes). KaTeX escapes its input. */
export function renderMath(tex: string, display = false): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'html' })
  } catch {
    return escapeHtml(tex)
  }
}

type Cell = string | number | boolean | null

/** A JSON array (or array of arrays) as an indexed grid of cells; null if the block is not one. */
function renderArray(body: string): string | null {
  let value: unknown
  try {
    value = JSON.parse(body.trim())
  } catch {
    return null
  }
  if (!Array.isArray(value) || !value.length || value.length > 200) return null
  const cell = (v: unknown) => {
    const text = v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v as Cell)
    return `<td>${escapeHtml(text.length > 40 ? `${text.slice(0, 37)}…` : text)}</td>`
  }
  const is2d = value.every((r) => Array.isArray(r)) && (value as unknown[][]).every((r) => r.length <= 50)
  if (is2d) {
    const rows = value as unknown[][]
    const width = Math.max(...rows.map((r) => r.length))
    const head = `<tr><th></th>${Array.from({ length: width }, (_, j) => `<th>${j}</th>`).join('')}</tr>`
    const bodyRows = rows.map((r, i) => `<tr><th>${i}</th>${Array.from({ length: width }, (_, j) => (j < r.length ? cell(r[j]) : '<td class="empty"></td>')).join('')}</tr>`).join('')
    return `<div class="array-view matrix"><table>${head}${bodyRows}</table></div>`
  }
  const items = value as unknown[]
  return `<div class="array-view"><table><tr>${items.map(cell).join('')}</tr><tr class="idx">${items.map((_, i) => `<th>${i}</th>`).join('')}</tr></table></div>`
}

/**
 * Convert a markdown note (tutor drafts, saved side chats, older notes) into
 * HTML the notepad can edit. Formulas become math nodes; the result is
 * sanitized, and the editor only keeps what its schema knows anyway.
 */
export function markdownToNoteHtml(md: string): string {
  const math: MathItem[] = []
  const html = String(DOMPurify.sanitize(marked.parse(extractMath(md, math), { async: false }) as string))
  return html.replace(/@@M(\d+)@@/g, (_m, i: string) => {
    const item = math[Number(i)]
    return item ? `<span data-math="" data-latex="${escapeHtml(item.tex.trim())}" data-display="${item.display}"></span>` : ''
  })
}
