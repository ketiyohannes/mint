import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { importDocx } from './docx'
import { importHtml } from './html'
import { refusalMessage, resolveLink, signInWall } from './links'
import { domainOf, safeFetch, type FetchedResource } from './net'
import { importPdf } from './pdf'
import { importMarkdown, importPlainText } from './text'
import type { FetchOptions, ImportedSource } from './types'
import { importYouTube, parseYouTubeId, type YouTubeClient } from './youtube'

export { normalizeSections, toAgentMarkdown, wordCount } from './normalize'
export type { RawBlock, RawSection } from './normalize'
export { domainOf, isDomainAllowed } from './net'
export { resolveLink } from './links'
export { listPlaylist, parseYouTubeId, parseYouTubePlaylistId, transcriptFromText, NO_TRANSCRIPT_MESSAGE } from './youtube'
export type { YouTubeClient } from './youtube'
export type { FetchOptions, ImportedSource } from './types'

/** Local files larger than this are refused before reading them into memory. */
const MAX_FILE_BYTES = 100 * 1024 * 1024

const SUPPORTED_FILES = 'PDF (.pdf), Markdown (.md), plain text (.txt), HTML (.html), and Word (.docx)'

/** Decodes text with the declared charset, falling back to UTF-8 for unknown labels. */
function decode(bytes: Uint8Array, charset?: string): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Charset from a `<meta charset>` / `http-equiv` tag in the first bytes of an HTML page. */
function sniffHtmlCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  return head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1]
}

function withOriginal(source: ImportedSource, bytes: Uint8Array, ext: string): ImportedSource {
  return { ...source, original: { bytes, ext } }
}

/** Imports a local file, choosing the importer by extension. */
export async function importFile(path: string): Promise<ImportedSource> {
  const fileName = basename(path)
  const ext = extname(path).toLowerCase().replace(/^\./, '')
  const supported = ['pdf', 'md', 'markdown', 'txt', 'html', 'htm', 'docx']
  if (!supported.includes(ext)) {
    throw new Error(`mint can't import "${fileName}". Supported files: ${SUPPORTED_FILES}.`)
  }

  const info = await stat(path)
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`"${fileName}" is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB.`)
  }
  const bytes = new Uint8Array(await readFile(path))

  switch (ext) {
    case 'pdf':
      return importPdf(bytes, fileName)
    case 'docx':
      return importDocx(bytes, fileName)
    case 'md':
    case 'markdown':
      return withOriginal(importMarkdown(decode(bytes), fileName), bytes, ext)
    case 'txt':
      return withOriginal(importPlainText(decode(bytes), fileName), bytes, ext)
    default: // html, htm
      return withOriginal(importHtml(decode(bytes, sniffHtmlCharset(bytes)), undefined, fileName.replace(/\.[^.]+$/, '')), bytes, ext)
  }
}

/**
 * A file name for title fallback: the URL's last path segment ("notes.pdf"),
 * or `<domain>.<ext>` so the importer's extension stripping leaves the domain.
 */
function fileNameFromUrl(url: string, ext: string): string {
  try {
    const segment = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')
    if (/[a-z]/i.test(segment)) return segment
  } catch {
    // Malformed percent-encoding: fall through to the domain.
  }
  return `${domainOf(url)}.${ext}`
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * Imports a URL: YouTube videos via their transcript, everything else via a
 * guarded fetch dispatched on content type (PDF, Word, HTML, markdown, plain
 * text). A link to a viewer page (a Google Doc, a paper's abstract, a file on
 * GitHub) is read from the address that serves the document itself.
 */
export async function importUrl(url: string, opts: FetchOptions & { innertube?: YouTubeClient } = {}): Promise<ImportedSource> {
  const { innertube, ...fetchOptions } = opts
  if (parseYouTubeId(url)) return importYouTube(url, { innertube, fetchImpl: fetchOptions.fetchImpl })

  const link = resolveLink(url)
  let fetched: FetchedResource
  try {
    fetched = await safeFetch(link.fetchUrl, fetchOptions)
  } catch (err) {
    const refused = refusalMessage(link, err)
    if (refused) throw new Error(refused)
    throw err
  }
  const { finalUrl, contentType, bytes } = fetched
  // The source keeps the page the learner linked to, not the download behind it.
  const pageUrl = link.fetchUrl === link.pageUrl ? finalUrl : link.pageUrl
  const domain = domainOf(pageUrl)
  const [mime = '', ...params] = contentType
    .toLowerCase()
    .split(';')
    .map((p) => p.trim())
  const charset = params
    .find((p) => p.startsWith('charset='))
    ?.slice('charset='.length)
    .replace(/"/g, '')
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512)).trimStart()
  const path = new URL(finalUrl).pathname.toLowerCase()
  /** The name the server gives the download says more than the address of an export does. */
  const fileName = (ext: string): string => (fetched.fileName && /[a-z]/i.test(fetched.fileName) ? fetched.fileName : fileNameFromUrl(finalUrl, ext))

  const looksLikePdf = mime === 'application/pdf' || head.startsWith('%PDF-')
  const looksLikeHtml = mime === 'text/html' || mime === 'application/xhtml+xml' || ((mime === '' || mime === 'application/octet-stream') && /^(<!doctype html|<html)/i.test(head))
  // A Word file is a zip: the type or the name has to say which kind.
  const looksLikeDocx = mime === DOCX_MIME || (head.startsWith('PK') && /\.docx$/i.test(fetched.fileName ?? path))
  const looksLikeMarkdown = mime === 'text/markdown' || mime === 'text/x-markdown' || (mime === 'text/plain' && /\.(md|markdown)$/.test(path))

  const wall = signInWall(link, looksLikeHtml)
  if (wall) throw new Error(wall)

  if (looksLikePdf) {
    const source = await importPdf(bytes, fileName('pdf'))
    return { ...source, url: pageUrl, domain }
  }
  if (looksLikeDocx) {
    const source = await importDocx(bytes, fileName('docx'))
    return { ...source, url: pageUrl, domain }
  }
  if (looksLikeHtml) {
    return importHtml(decode(bytes, charset ?? sniffHtmlCharset(bytes)), pageUrl, domain)
  }
  if (looksLikeMarkdown) {
    const source = importMarkdown(decode(bytes, charset), fileName('md'))
    return { ...source, url: pageUrl, domain }
  }
  if (mime === 'text/plain' || mime === 'text/csv') {
    const source = importPlainText(decode(bytes, charset), fileName('txt'))
    return { ...source, url: pageUrl, domain }
  }
  throw new Error(`mint can't import ${mime || 'this kind of content'} from ${domain}. Supported links: web pages, PDFs, Word and Google documents, plain text, and YouTube videos or playlists.`)
}
