import { languageFromName, type LanguageId } from './languages'

/**
 * An answer to a check is written as parts: prose, and code in a language. It
 * is stored, sent to the tutor and kept as a draft as one string, with each
 * code part in a fenced block (```rust ... ```), the form the tutor reads and
 * writes code in too.
 */
export type AnswerPart = { type: 'text'; text: string } | { type: 'code'; language: LanguageId; code: string }

/** An opening fence at the start of a line: three or more backticks, then the language. */
const FENCE = /^(`{3,})[ \t]*([^\s`]*)[^\n`]*$/

/** Split an answer into its parts. A fence left open runs to the end, as in markdown. */
export function parseAnswer(answer: string): AnswerPart[] {
  const parts: AnswerPart[] = []
  let prose: string[] = []
  const flush = () => {
    const text = prose.join('\n').trim()
    if (text) parts.push({ type: 'text', text })
    prose = []
  }
  const lines = answer.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i])
    if (!open) {
      prose.push(lines[i])
      continue
    }
    flush()
    const code: string[] = []
    for (i++; i < lines.length; i++) {
      // The closing fence is at least as long as the opening one, and has nothing after it.
      if (lines[i].startsWith(open[1]) && /^`+\s*$/.test(lines[i])) break
      code.push(lines[i])
    }
    parts.push({ type: 'code', language: languageFromName(open[2]) ?? 'plain', code: code.join('\n') })
  }
  flush()
  return parts
}

/** A fence longer than any run of backticks in the code, so the code cannot close it. */
function fenceFor(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * The parts as one string. Empty parts are left out, unless `keepEmpty` asks
 * for empty code blocks too (a draft keeps a block the learner has just added).
 */
export function formatAnswer(parts: readonly AnswerPart[], opts: { keepEmpty?: boolean } = {}): string {
  const out: string[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.trim()) out.push(part.text.trim())
      continue
    }
    const code = part.code.replace(/\s+$/, '')
    if (!code.trim() && !opts.keepEmpty) continue
    const fence = fenceFor(code)
    out.push(`${fence}${part.language === 'plain' ? '' : part.language}\n${code}${code ? '\n' : ''}${fence}`)
  }
  return out.join('\n\n')
}
