/**
 * Builders for binary test fixtures, so tests do not depend on committed
 * opaque files: a minimal valid PDF (text drawn with Helvetica, one content
 * stream per page, correct xref offsets) and a minimal .docx (an uncompressed
 * zip with the parts mammoth needs).
 */
import { crc32 } from 'node:zlib'

const encoder = new TextEncoder()

function escapePdfString(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`)
}

/**
 * Builds a PDF where `pages[i]` is the list of text lines on page i + 1.
 * Lines are drawn top to bottom; an empty string leaves a blank line.
 */
export function buildPdf(pages: string[][], info: { title?: string } = {}): Uint8Array<ArrayBuffer> {
  // Object numbers: 1 catalog, 2 pages, 3 font, 4 info, then (page, content) pairs.
  const pageObjectIds = pages.map((_, i) => 5 + i * 2)
  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects[4] = info.title ? `<< /Title (${escapePdfString(info.title)}) /Producer (mint tests) >>` : '<< /Producer (mint tests) >>'

  pages.forEach((lines, i) => {
    const pageId = pageObjectIds[i]
    const contentId = pageId + 1
    const ops = lines.length
      ? ['BT', '/F1 11 Tf', '14 TL', '72 720 Td', ...lines.map((line) => `(${escapePdfString(line)}) Tj T*`), 'ET'].join('\n')
      : ''
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
    objects[contentId] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`
  })

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length // ASCII only, so string length equals byte offset
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefOffset = out.length
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return encoder.encode(out)
}

// ---------------------------------------------------------------------------
// ZIP (stored, no compression) and DOCX
// ---------------------------------------------------------------------------

export function buildZip(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date: 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    // extra length, comment length, disk, internal attrs, external attrs: all zero
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + data.length
  }

  const centralDir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  const count = Object.keys(files).length
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralDir.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, centralDir, end]))
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Builds a .docx whose body is a list of paragraphs, optionally styled "Heading 1".."Heading 3". */
export function buildDocx(paragraphs: Array<{ text: string; heading?: 1 | 2 | 3 }>): Uint8Array<ArrayBuffer> {
  const body = paragraphs
    .map(({ text, heading }) => {
      const props = heading ? `<w:pPr><w:pStyle w:val="Heading${heading}"/></w:pPr>` : ''
      return `<w:p>${props}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
    })
    .join('')

  const headingStyles = [1, 2, 3]
    .map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`)
    .join('')

  return buildZip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/_rels/document.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}">${headingStyles}</w:styles>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`
  })
}
