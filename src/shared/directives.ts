/**
 * Inline directives the tutor may embed in its markdown replies.
 *
 *   [[cite:<sourceId>|<section label>|<short exact quote>]]   jump-to-source chip
 *   [[highlight:<elementId>]]                                  emphasize a diagram part
 *   [[set:<paramId>=<number>]]                                 move a diagram slider
 *   [[offer:quiz|<focus>]]  [[offer:code|<focus>]]  [[offer:diagram|<what to draw>]]
 *                                                              a button that runs that tool in the chat
 *
 * Directives are parsed by code (never trusted as HTML) and rendered as UI.
 */

export type Directive =
  | { type: 'cite'; sourceId: string; section: string; quote: string }
  | { type: 'highlight'; elementId: string }
  | { type: 'set'; paramId: string; value: number }
  | { type: 'offer'; tool: OfferTool; arg: string }

export type OfferTool = 'quiz' | 'code' | 'diagram'
const OFFER_TOOLS: OfferTool[] = ['quiz', 'code', 'diagram']

export type Segment = { kind: 'text'; text: string } | { kind: 'directive'; directive: Directive; raw: string }

const DIRECTIVE_RE = /\[\[(cite|highlight|set|offer):([^\]]{1,600})\]\]/g

export function parseDirective(type: string, body: string): Directive | null {
  if (type === 'cite') {
    const [sourceId, section = '', ...quoteParts] = body.split('|')
    const id = sourceId?.trim()
    if (!id) return null
    return {
      type: 'cite',
      sourceId: id,
      section: section.trim(),
      quote: quoteParts
        .join('|')
        .trim()
        .replace(/^["“]|["”]$/g, '')
    }
  }
  if (type === 'highlight') {
    const elementId = body.trim()
    return elementId ? { type: 'highlight', elementId } : null
  }
  if (type === 'offer') {
    const [tool, ...rest] = body.split('|')
    const t = tool?.trim().toLowerCase() as OfferTool
    if (!OFFER_TOOLS.includes(t)) return null
    return { type: 'offer', tool: t, arg: rest.join('|').trim().slice(0, 300) }
  }
  if (type === 'set') {
    const m = /^\s*([\w.-]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/.exec(body)
    if (!m) return null
    return { type: 'set', paramId: m[1], value: Number(m[2]) }
  }
  return null
}

/** Split text into plain segments and directives (unknown/invalid directives stay as text). */
export function splitDirectives(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(DIRECTIVE_RE)) {
    const idx = m.index ?? 0
    const directive = parseDirective(m[1], m[2])
    if (!directive) continue
    if (idx > last) out.push({ kind: 'text', text: text.slice(last, idx) })
    out.push({ kind: 'directive', directive, raw: m[0] })
    last = idx + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

export function extractDirectives(text: string): Directive[] {
  return splitDirectives(text).flatMap((s) => (s.kind === 'directive' ? [s.directive] : []))
}
