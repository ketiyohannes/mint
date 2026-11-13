import { StreamLanguage, type Language, type LanguageSupport, type StreamParser } from '@codemirror/language'
import { classHighlighter, highlightCode } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { java } from '@codemirror/lang-java'
import { csharp, kotlin } from '@codemirror/legacy-modes/mode/clike'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { haskell } from '@codemirror/legacy-modes/mode/haskell'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { r } from '@codemirror/legacy-modes/mode/r'
import { languageFromName, type LanguageId } from '@shared/languages'

const ZIG_KEYWORDS = new Set(
  'addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while'.split(
    ' '
  )
)
const ZIG_ATOMS = new Set(['true', 'false', 'null', 'undefined'])
const ZIG_TYPE = /^(?:[iu]\d+|f(?:16|32|64|80|128)|[iu]size|bool|void|noreturn|type|anyerror|anyopaque|comptime_int|comptime_float|c_\w+|[A-Z]\w*)$/
const ZIG_NUMBER = /^(?:0x[\da-fA-F_]+(?:\.[\da-fA-F_]+)?(?:[pP][+-]?\d+)?|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/

/** Zig has no CodeMirror grammar: a line-by-line tokenizer is enough to colour it. */
const zig: StreamParser<null> = {
  name: 'zig',
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    // A line of a multiline string starts with two backslashes.
    if (stream.match('\\\\')) {
      stream.skipToEnd()
      return 'string'
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)+'/)) return 'string'
    if (stream.match(/^@"(?:[^"\\]|\\.)*"/)) return 'variable'
    if (stream.match(/^@[A-Za-z_]\w*/)) return 'builtin'
    if (stream.match(ZIG_NUMBER)) return 'number'
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const word = stream.current()
      if (ZIG_KEYWORDS.has(word)) return 'keyword'
      if (ZIG_ATOMS.has(word)) return 'atom'
      return ZIG_TYPE.test(word) ? 'type' : 'variable'
    }
    if (stream.match(/^[-+*/%=<>!&|^~?]+/)) return 'operator'
    stream.next()
    return null
  },
  languageData: { commentTokens: { line: '//' } }
}

interface Entry {
  /** What the editor loads: the grammar, with whatever editing help the language package brings. */
  support: () => LanguageSupport | Language
  /** Spaces per indent step. */
  indent: number
}

const stream =
  <T>(mode: StreamParser<T>) =>
  (): Language =>
    StreamLanguage.define(mode)

const ENTRIES: Record<Exclude<LanguageId, 'plain'>, Entry> = {
  python: { support: python, indent: 4 },
  javascript: { support: () => javascript({ jsx: true }), indent: 2 },
  typescript: { support: () => javascript({ typescript: true, jsx: true }), indent: 2 },
  c: { support: cpp, indent: 4 },
  cpp: { support: cpp, indent: 4 },
  rust: { support: rust, indent: 4 },
  zig: { support: stream(zig), indent: 4 },
  go: { support: go, indent: 4 },
  java: { support: java, indent: 4 },
  csharp: { support: stream(csharp), indent: 4 },
  kotlin: { support: stream(kotlin), indent: 4 },
  swift: { support: stream(swift), indent: 4 },
  ruby: { support: stream(ruby), indent: 2 },
  sql: { support: stream(standardSQL), indent: 2 },
  shell: { support: stream(shell), indent: 2 },
  haskell: { support: stream(haskell), indent: 2 },
  lua: { support: stream(lua), indent: 2 },
  r: { support: stream(r), indent: 2 }
}

const loaded = new Map<LanguageId, LanguageSupport | Language>()

/** The CodeMirror language for one of ours (null for plain text). Built once, on first use. */
export function codeLanguage(id: LanguageId): LanguageSupport | Language | null {
  if (id === 'plain') return null
  let support = loaded.get(id)
  if (!support) loaded.set(id, (support = ENTRIES[id].support()))
  return support
}

export function indentSize(id: LanguageId): number {
  return id === 'plain' ? 2 : ENTRIES[id].indent
}

/** A run of code with the classes that colour it ("tok-keyword"; empty for plain text). */
export interface CodeToken {
  text: string
  classes: string
}

/** Past this, code is shown uncoloured: parsing is for answers and examples, not files. */
const MAX_HIGHLIGHT = 40_000

/**
 * Code as lines of coloured runs, for showing it without an editor. The same
 * grammars and the same classes (styles.css, ".tok-*") as the editor.
 */
export function highlightLines(code: string, id: LanguageId): CodeToken[][] {
  const support = code.length <= MAX_HIGHLIGHT ? codeLanguage(id) : null
  if (!support) return code.split('\n').map((text) => [{ text, classes: '' }])
  const language = 'language' in support ? support.language : support
  const lines: CodeToken[][] = [[]]
  highlightCode(
    code,
    language.parser.parse(code),
    classHighlighter,
    (text, classes) => lines[lines.length - 1].push({ text, classes }),
    () => lines.push([])
  )
  return lines
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The same, as escaped HTML for a <code> element. `name` is whatever the fence said; unknown names stay uncoloured. */
export function highlightHtml(code: string, name: string): string {
  return highlightLines(code, languageFromName(name) ?? 'plain')
    .map((line) => line.map((t) => (t.classes ? `<span class="${t.classes}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text))).join(''))
    .join('\n')
}
