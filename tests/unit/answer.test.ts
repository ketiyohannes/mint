import { describe, expect, it } from 'vitest'
import { formatAnswer, parseAnswer, type AnswerPart } from '../../src/shared/answer'
import { CODE_LANGUAGES, LANGUAGE_IDS, languageFromName, languageLabel } from '../../src/shared/languages'
import { codeLanguage, highlightHtml, highlightLines } from '../../src/renderer/src/lib/codeLanguages'

describe('answers with code', () => {
  it('splits an answer into its text and its code blocks, in order', () => {
    const answer = 'It keeps a running total.\n\n```rust\nfn sum(xs: &[i32]) -> i32 {\n    xs.iter().sum()\n}\n```\n\nThat is O(n).\n```py\nprint(1)\n```'
    expect(parseAnswer(answer)).toEqual([
      { type: 'text', text: 'It keeps a running total.' },
      { type: 'code', language: 'rust', code: 'fn sum(xs: &[i32]) -> i32 {\n    xs.iter().sum()\n}' },
      { type: 'text', text: 'That is O(n).' },
      { type: 'code', language: 'python', code: 'print(1)' }
    ])
    expect(parseAnswer('Just words, with `code` and ```inline``` in them.')).toEqual([{ type: 'text', text: 'Just words, with `code` and ```inline``` in them.' }])
    expect(parseAnswer('   \n')).toEqual([])
  })

  it('reads a fence with no language, an unknown one, or one left open as code', () => {
    expect(parseAnswer('```\nx = 1\n```')).toEqual([{ type: 'code', language: 'plain', code: 'x = 1' }])
    expect(parseAnswer('```ocaml\nlet x = 1\n```')).toEqual([{ type: 'code', language: 'plain', code: 'let x = 1' }])
    expect(parseAnswer('see:\n```zig\nconst x = 1;')).toEqual([
      { type: 'text', text: 'see:' },
      { type: 'code', language: 'zig', code: 'const x = 1;' }
    ])
  })

  it('writes parts back as the same answer, whatever the code contains', () => {
    const parts: AnswerPart[] = [
      { type: 'text', text: '  First the idea.  ' },
      { type: 'code', language: 'typescript', code: 'const fence = "```"\n\n' },
      { type: 'text', text: '' },
      { type: 'code', language: 'plain', code: 'for each x: add x' },
      { type: 'code', language: 'c', code: '   ' }
    ]
    const answer = formatAnswer(parts)
    expect(answer).toBe('First the idea.\n\n````typescript\nconst fence = "```"\n````\n\n```\nfor each x: add x\n```')
    expect(parseAnswer(answer)).toEqual([
      { type: 'text', text: 'First the idea.' },
      { type: 'code', language: 'typescript', code: 'const fence = "```"' },
      { type: 'code', language: 'plain', code: 'for each x: add x' }
    ])
    // A draft keeps the block that is still empty; nothing written is nothing to send.
    expect(formatAnswer(parts, { keepEmpty: true })).toContain('```c\n```')
    expect(formatAnswer([{ type: 'code', language: 'rust', code: '' }])).toBe('')
    expect(parseAnswer(formatAnswer([{ type: 'code', language: 'rust', code: '' }], { keepEmpty: true }))).toEqual([{ type: 'code', language: 'rust', code: '' }])
  })
})

describe('code languages', () => {
  it('knows the major languages by their usual names', () => {
    for (const id of ['python', 'c', 'cpp', 'typescript', 'rust', 'zig', 'go', 'java'] as const) expect(LANGUAGE_IDS).toContain(id)
    expect(languageFromName('C++')).toBe('cpp')
    expect(languageFromName(' TSX ')).toBe('typescript')
    expect(languageFromName('py')).toBe('python')
    expect(languageFromName('rs')).toBe('rust')
    expect(languageFromName('bash')).toBe('shell')
    expect(languageFromName('brainfuck')).toBeNull()
    expect(languageFromName(undefined)).toBeNull()
    expect(languageLabel('csharp')).toBe('C#')
  })

  it('has a grammar for every language but plain text, and colours its keywords', () => {
    const samples: Record<string, string> = {
      python: 'def f(x):\n    return x',
      javascript: 'const x = 1',
      typescript: 'const x: number = 1',
      c: 'int main(void) { return 0; }',
      cpp: 'class A { public: int x; };',
      rust: 'fn main() { let x = 1; }',
      zig: 'const std = @import("std");\npub fn main() void {}',
      go: 'func main() { return }',
      java: 'class A { int x; }',
      csharp: 'class A { int x; }',
      kotlin: 'fun main() { val x = 1 }',
      swift: 'func main() { let x = 1 }',
      ruby: 'def f\n  return 1\nend',
      sql: 'SELECT a FROM t WHERE a = 1',
      shell: 'if true; then echo hi; fi',
      haskell: 'module Main where\nimport Data.List',
      lua: 'local function f() return 1 end',
      r: 'f <- function(x) { return(x) }'
    }
    for (const { id } of CODE_LANGUAGES) {
      if (id === 'plain') continue
      expect(codeLanguage(id), id).not.toBeNull()
      const classes = highlightLines(samples[id], id)
        .flat()
        .map((t) => t.classes)
        .join(' ')
      expect(classes, id).toContain('tok-keyword')
    }
    expect(codeLanguage('plain')).toBeNull()
  })

  it('shows code as lines of coloured runs that add up to the code, escaped for HTML', () => {
    const code = 'const a = "<b>";\n// done'
    const lines = highlightLines(code, 'zig')
    expect(lines.map((line) => line.map((t) => t.text).join('')).join('\n')).toBe(code)
    expect(lines[1][0]).toEqual({ text: '// done', classes: 'tok-comment' })
    const html = highlightHtml(code, 'zig')
    expect(html).toContain('<span class="tok-keyword">const</span>')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
    // A name that is not a language of ours is shown as written.
    expect(highlightHtml('a < b', 'whatever')).toBe('a &lt; b')
    expect(highlightLines('x = 1\ny = 2', 'plain')).toEqual([[{ text: 'x = 1', classes: '' }], [{ text: 'y = 2', classes: '' }]])
  })
})
