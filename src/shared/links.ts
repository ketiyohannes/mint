/** The most links one request takes: a pasted page of text must not start hundreds of imports. */
export const MAX_LINKS = 25

/** Punctuation that ends a sentence or wraps a link, not the link itself. */
const TRAILING = /[.,;:!?'"»”’>\]}]+$/

/** A closing bracket belongs to the link only when the link opens one ("…/Rust_(language)"). */
function trimBracket(link: string): string {
  let out = link
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) out = out.slice(0, -1)
  return out
}

function clean(raw: string): string | null {
  let link = raw
  for (;;) {
    const next = trimBracket(link.replace(TRAILING, ''))
    if (next === link) break
    link = next
  }
  try {
    const url = new URL(link)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.') ? link : null
  } catch {
    return null
  }
}

/**
 * The web links in a piece of text, in order and without repeats: pasted one
 * per line, separated by spaces or commas, or in the middle of a sentence.
 */
export function linksIn(text: string): string[] {
  const out: string[] = []
  for (const match of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`,]+/gi)) {
    const link = clean(match[0])
    if (link && !out.includes(link)) out.push(link)
  }
  return out
}

/**
 * What a learner typed into a field for links. A lone address without its
 * scheme ("arxiv.org/abs/1706.03762") counts too: that is how people type one.
 */
export function linksFromInput(text: string): string[] {
  const found = linksIn(text)
  if (found.length) return found
  const bare = String(text ?? '').trim()
  if (!bare || /\s/.test(bare) || !/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(bare)) return []
  const link = clean(`https://${bare}`)
  return link ? [link] : []
}
