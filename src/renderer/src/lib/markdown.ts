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

/**
 * Render tutor markdown safely:
 *  1. directives and math are swapped for inert tokens,
 *  2. markdown is rendered and sanitized with DOMPurify,
 *  3. tokens are replaced with escaped chip/KaTeX markup.
 * Model text never reaches innerHTML unsanitized.
 */
export function renderMarkdown(text: string, labelForSource?: (sourceId: string) => string | undefined): RenderedMarkdown {
  const directives: Directive[] = []
  const math: { tex: string; display: boolean }[] = []

  let prepared = splitDirectives(text)
    .map((seg) => {
      if (seg.kind === 'text') return seg.text
      directives.push(seg.directive)
      return `@@D${directives.length - 1}@@`
    })
    .join('')

  // Display math first, then inline math. Escaped dollars are left alone.
  prepared = prepared.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => {
    math.push({ tex, display: true })
    return `@@M${math.length - 1}@@`
  })
  prepared = prepared.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_m, pre: string, tex: string) => {
    math.push({ tex, display: false })
    return `${pre}@@M${math.length - 1}@@`
  })
  prepared = prepared.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => {
    math.push({ tex, display: true })
    return `@@M${math.length - 1}@@`
  })
  prepared = prepared.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => {
    math.push({ tex, display: false })
    return `@@M${math.length - 1}@@`
  })

  const raw = marked.parse(prepared, { async: false }) as string
  let html: string = String(DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] }))

  html = html.replace(/@@M(\d+)@@/g, (_m, i: string) => {
    const item = math[Number(i)]
    if (!item) return ''
    try {
      return katex.renderToString(item.tex, { displayMode: item.display, throwOnError: false, strict: 'ignore', trust: false, output: 'html' })
    } catch {
      return escapeHtml(item.tex)
    }
  })
  html = html.replace(/@@D(\d+)@@/g, (_m, i: string) => {
    const d = directives[Number(i)]
    if (!d) return ''
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
