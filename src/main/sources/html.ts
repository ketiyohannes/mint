import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import { domainOf } from './net'
import { chunkIntoParts, collapseWhitespace, normalizeSections, truncateLabel, type RawBlock, type RawSection } from './normalize'
import type { ImportedSource } from './types'

// Node.nodeType values (no DOM globals in the main process).
const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** Elements whose content is never reading material. */
const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'button',
  'input',
  'select',
  'textarea',
  'form',
  'math',
  'video',
  'audio',
  'picture',
  'img',
  'head'
])

/** Page chrome, skipped only in the no-Readability fallback (Readability already removes it). */
const CHROME_TAGS = new Set(['nav', 'aside', 'header', 'footer', 'menu'])

/** Elements that start a new block; everything else is treated as inline text. */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'dialog',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'ul',
  'body',
  'center'
])

function tagOf(el: Element): string {
  return el.tagName.toLowerCase()
}

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE
}

/** Visible text of an inline subtree; `<br>` becomes a space so words do not fuse. */
function inlineText(node: Node): string {
  if (node.nodeType === TEXT_NODE) return node.textContent ?? ''
  if (!isElement(node)) return ''
  const tag = tagOf(node)
  if (tag === 'br') return ' '
  if (SKIP_TAGS.has(tag)) return ''
  let text = ''
  for (const child of Array.from(node.childNodes)) text += inlineText(child)
  return text
}

function hasBlockChild(el: Element): boolean {
  return Array.from(el.children).some((child) => BLOCK_TAGS.has(tagOf(child)))
}

interface WalkOptions {
  /** Skip nav/aside/header/footer (used when Readability could not isolate the article). */
  skipChrome: boolean
}

/**
 * Walks HTML in document order and groups it into sections. Every h1/h2
 * starts a section (label = heading text, truncated); h3-h6 become heading
 * blocks. Content before the first h1/h2 goes in "Introduction". A document
 * with no h1/h2 at all is split into "Part N" sections instead.
 */
export function htmlToRawSections(root: Element, options: WalkOptions = { skipChrome: false }): RawSection[] {
  const sections: RawSection[] = []
  const preamble: RawBlock[] = []
  let current: RawSection | null = null

  const push = (block: RawBlock): void => {
    if (!collapseWhitespace(block.text)) return
    if (current) current.blocks.push(block)
    else preamble.push(block)
  }

  const startSection = (headingText: string): void => {
    const text = collapseWhitespace(headingText)
    if (!text) return
    const label = truncateLabel(text)
    current = { label, ...(label !== text ? { title: text } : {}), blocks: [] }
    sections.push(current)
  }

  const walkListItem = (item: Element): void => {
    // The item's own text, excluding nested lists, then the nested lists in order.
    let own = ''
    const nested: Element[] = []
    for (const child of Array.from(item.childNodes)) {
      if (!isElement(child)) {
        own += inlineText(child)
        continue
      }
      const tag = tagOf(child)
      if (tag === 'ul' || tag === 'ol') {
        nested.push(child)
      } else if (BLOCK_TAGS.has(tag) && tag !== 'p' && tag !== 'div') {
        // Rare: code or a quote inside a list item. Emit the text so far, then the block.
        push({ type: 'list-item', text: own })
        own = ''
        walk(child)
      } else {
        own += ` ${inlineText(child)} `
      }
    }
    push({ type: 'list-item', text: own })
    nested.forEach(walkList)
  }

  const walkList = (list: Element): void => {
    for (const item of Array.from(list.children)) {
      if (tagOf(item) === 'li') walkListItem(item)
      else walk(item)
    }
  }

  const walkTable = (table: Element): void => {
    const caption = table.querySelector('caption')
    if (caption) push({ type: 'paragraph', text: inlineText(caption) })
    for (const row of Array.from(table.querySelectorAll('tr'))) {
      const cells = Array.from(row.children)
        .filter((cell) => tagOf(cell) === 'td' || tagOf(cell) === 'th')
        .map((cell) => collapseWhitespace(inlineText(cell)))
        .filter(Boolean)
      if (cells.length) push({ type: 'paragraph', text: cells.join(' | ') })
    }
  }

  const walkQuote = (quote: Element): void => {
    if (!hasBlockChild(quote)) {
      push({ type: 'quote', text: inlineText(quote) })
      return
    }
    // One quote block per paragraph-like child; inline runs between them are their own quotes.
    let inline = ''
    for (const child of Array.from(quote.childNodes)) {
      if (isElement(child) && BLOCK_TAGS.has(tagOf(child))) {
        push({ type: 'quote', text: inline })
        inline = ''
        push({ type: 'quote', text: hasBlockChild(child) ? (child.textContent ?? '') : inlineText(child) })
      } else inline += inlineText(child)
    }
    push({ type: 'quote', text: inline })
  }

  /** Generic container: inline runs become paragraphs, block children are walked. */
  const walkChildren = (el: Element): void => {
    let inline = ''
    for (const child of Array.from(el.childNodes)) {
      if (isElement(child) && BLOCK_TAGS.has(tagOf(child))) {
        push({ type: 'paragraph', text: inline })
        inline = ''
        walk(child)
      } else inline += inlineText(child)
    }
    push({ type: 'paragraph', text: inline })
  }

  const walk = (el: Element): void => {
    const tag = tagOf(el)
    if (SKIP_TAGS.has(tag)) return
    if (options.skipChrome && CHROME_TAGS.has(tag)) return
    if (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true') return

    switch (tag) {
      case 'h1':
      case 'h2':
        startSection(inlineText(el))
        return
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        push({ type: 'heading', text: inlineText(el), level: Number(tag[1]) })
        return
      case 'p':
      case 'figcaption':
      case 'dt':
      case 'dd':
      case 'summary':
      case 'caption':
        if (hasBlockChild(el)) walkChildren(el)
        else push({ type: 'paragraph', text: inlineText(el) })
        return
      case 'ul':
      case 'ol':
      case 'menu':
        walkList(el)
        return
      case 'li':
        walkListItem(el)
        return
      case 'blockquote':
        walkQuote(el)
        return
      case 'pre':
        push({ type: 'code', text: el.textContent ?? '' })
        return
      case 'table':
        walkTable(el)
        return
      case 'hr':
        return
      default:
        walkChildren(el)
    }
  }

  walk(root)

  if (sections.length === 0) return chunkIntoParts(preamble)
  if (preamble.length) sections.unshift({ label: 'Introduction', blocks: preamble })
  return sections
}

interface ParsedArticle {
  title?: string
  byline?: string
  sections: RawSection[]
}

/**
 * Removes elements that are page chrome by definition. Readability scores
 * content heuristically and can keep a nav bar on short pages, so explicit
 * landmarks are dropped up front. header/footer/aside inside an article are
 * kept (article headers hold the title; asides may be callouts).
 */
function removePageChrome(doc: Document): void {
  const landmarks = doc.querySelectorAll('nav, [role="navigation"], [role="banner"], [role="contentinfo"], [role="search"]')
  for (const el of Array.from(landmarks)) el.remove()
  for (const el of Array.from(doc.querySelectorAll('header, footer, aside'))) {
    if (!el.closest('article, main, [role="main"]')) el.remove()
  }
}

/** Runs Readability; returns null when it cannot find an article. */
function parseWithReadability(html: string, url: string | undefined): ParsedArticle | null {
  const dom = new JSDOM(html, url ? { url } : {})
  try {
    removePageChrome(dom.window.document)
    // Return the article element itself instead of serialized HTML so we
    // do not have to parse the content a second time.
    const article = new Readability<Node>(dom.window.document, { serializer: (node) => node }).parse()
    if (!article?.content || !isElement(article.content)) return null
    const sections = htmlToRawSections(article.content)
    if (!sections.some((s) => s.blocks.length > 0)) return null
    return {
      title: article.title ?? undefined,
      byline: article.byline ?? undefined,
      sections
    }
  } catch {
    return null
  } finally {
    dom.window.close()
  }
}

/** Fallback when Readability fails: walk the whole body, minus page chrome. */
function parseBody(html: string, url: string | undefined): ParsedArticle {
  const dom = new JSDOM(html, url ? { url } : {})
  try {
    const doc = dom.window.document
    return {
      title: doc.title || doc.querySelector('h1')?.textContent || undefined,
      sections: doc.body ? htmlToRawSections(doc.body, { skipChrome: true }) : []
    }
  } finally {
    dom.window.close()
  }
}

/**
 * Imports an HTML document (a fetched web page when `url` is set, otherwise a
 * local .html file). Readability strips navigation, sidebars, and ads.
 */
export function importHtml(html: string, url: string | undefined, fallbackTitle: string): ImportedSource {
  const parsed = parseWithReadability(html, url) ?? parseBody(html, url)
  const sections = normalizeSections(parsed.sections)
  if (sections.length === 0) throw new Error('Could not find any readable text on this page.')

  const title = collapseWhitespace(parsed.title ?? '') || collapseWhitespace(fallbackTitle) || 'Untitled'
  const author = collapseWhitespace(parsed.byline ?? '').replace(/^by\s+/i, '')
  return {
    kind: url ? 'web' : 'html',
    title,
    ...(url ? { url, domain: domainOf(url) } : {}),
    ...(author ? { author } : {}),
    sections
  }
}

/** Parses an HTML fragment (no Readability) into raw sections. Used for clean HTML such as mammoth output. */
export function htmlFragmentToRawSections(html: string): RawSection[] {
  const dom = new JSDOM(html)
  try {
    const body = dom.window.document.body
    return body ? htmlToRawSections(body) : []
  } finally {
    dom.window.close()
  }
}
