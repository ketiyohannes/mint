/**
 * A passage the learner brought into the main chat ("Add to chat" on a
 * highlight). It travels as a markdown blockquote at the top of the message,
 * so the tutor reads it naturally and the transcript stays plain text:
 *
 *   > the quoted passage
 *   > — Source title · section
 *
 *   the learner's question
 */

const SOURCE_PREFIX = '— '

export function quoteMessage(quote: string, source: string, question: string): string {
  const lines = quote
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((l) => `> ${l}`.trimEnd())
  if (source.trim()) lines.push(`> ${SOURCE_PREFIX}${source.trim()}`)
  return `${lines.join('\n')}\n\n${question.trim()}`
}

export interface SplitQuoted {
  quote: string | null
  source: string | null
  body: string
}

/** Split a message into its leading quote (if any), the quote's source line, and the rest. */
export function splitQuoted(text: string): SplitQuoted {
  const m = /^((?:>[^\n]*(?:\n|$))+)\n*([\s\S]*)$/.exec(text)
  if (!m) return { quote: null, source: null, body: text }
  const lines = m[1]
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .map((l) => l.replace(/^> ?/, ''))
  let source: string | null = null
  if (lines.length > 1 && lines[lines.length - 1].startsWith(SOURCE_PREFIX)) source = lines.pop()!.slice(SOURCE_PREFIX.length).trim() || null
  const quote = lines.join('\n').trim()
  return { quote: quote || null, source, body: m[2].trim() }
}

/** A chat title from a message: the question when there is one, else the quoted passage. */
export function titleText(message: string): string {
  const { quote, body } = splitQuoted(message)
  return (body || quote || message).replace(/\s+/g, ' ').trim()
}
