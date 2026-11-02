import mammoth from 'mammoth'
import { htmlFragmentToRawSections } from './html'
import { normalizeSections, titleFromFileName } from './normalize'
import type { ImportedSource } from './types'

/**
 * Imports a Word document. mammoth maps Word styles to semantic HTML
 * (Heading 1 -> h1, lists -> ul/ol, ...), which we then walk like any other
 * HTML, so sections follow the document's Heading 1/2 structure.
 */
export async function importDocx(bytes: Uint8Array, fileName: string): Promise<ImportedSource> {
  let html: string
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })
    html = result.value
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`This file could not be read as a Word document (${reason}).`)
  }

  const sections = normalizeSections(htmlFragmentToRawSections(html))
  if (sections.length === 0) throw new Error('This Word document has no text.')

  return {
    kind: 'docx',
    title: titleFromFileName(fileName),
    sections,
    original: { bytes, ext: 'docx' }
  }
}
