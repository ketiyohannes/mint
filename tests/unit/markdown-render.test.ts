// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { markdownToNoteHtml, renderMarkdown } from '../../src/renderer/src/lib/markdown'

/** The text of the first code block, as the copy button would take it. */
function codeText(html: string): string {
  const box = document.createElement('div')
  box.innerHTML = html
  return box.querySelector('pre')?.textContent ?? ''
}

/** The full render needs a DOM (DOMPurify), so this file runs in jsdom. */
describe('renderMarkdown', () => {
  it('renders formulas in prose with KaTeX and leaves code as written', () => {
    const { html } = renderMarkdown('Use $x^2$ here.\n\n```js\nconst s = `${a}${b}`\n```\n\nType `$y$`.')
    expect(html.match(/class="katex"/g)).toHaveLength(1)
    expect(codeText(html)).toBe('const s = `${a}${b}`')
    expect(html).toContain('<code>$y$</code>')
  })

  it('colours fenced code in its language, and escapes it', () => {
    const { html } = renderMarkdown('```rust\nfn main() { let s = "<b>"; }\n```')
    expect(html).toContain('<span class="tok-keyword">fn</span>')
    expect(html).toContain('&lt;b&gt;')
    expect(codeText(html)).toBe('fn main() { let s = "<b>"; }')
    // No language, or one mint has no grammar for: shown as written.
    expect(renderMarkdown('```\na < b\n```').html).toContain('<pre><code>a &lt; b</code></pre>')
    expect(renderMarkdown('```cobol\nMOVE A TO B\n```').html).toContain('<pre><code>MOVE A TO B</code></pre>')
    // A citation inside code is still a chip, so that block is left uncoloured.
    const cited = renderMarkdown('```py\nx = 1  # [[cite:src1|p. 3]]\n```')
    expect(cited.html).toContain('class="cite-chip"')
    expect(cited.html).not.toContain('tok-')
  })

  it('gives each code block a copy button, and inline text none', () => {
    const block = renderMarkdown('```py\nprint(1)\n```').html
    expect(block).toMatch(/<div class="code-block"><pre><code>.*<\/code><\/pre><button type="button" class="code-copy"[^>]*data-testid="code-copy"[^>]*>Copy<\/button><\/div>/)
    expect(codeText(block)).toBe('print(1)')
    expect(renderMarkdown('`print(1)`', undefined, { inline: true }).html).not.toContain('code-copy')
  })

  it("drops class, id, style and data-* from the model's own HTML", () => {
    const { html } = renderMarkdown('<div class="overlay-panel" id="root" style="color:red" data-dir="0" data-message-id="m1">hello</div>')
    expect(html).toContain('<div>hello</div>')
    expect(html).not.toMatch(/overlay-panel|id=|style=|data-/)
  })

  it('keeps table alignment, and its own chips keep their classes', () => {
    const table = renderMarkdown('| a | b |\n|:-:|--:|\n| 1 | 2 |').html
    expect(table).toContain('align="center"')
    expect(table).toContain('align="right"')
    const cite = renderMarkdown('See [[cite:src1|p. 3|a quote]].')
    expect(cite.html).toContain('class="cite-chip" data-dir="0"')
    expect(cite.directives).toHaveLength(1)
  })
})

describe('markdownToNoteHtml', () => {
  it('turns formulas into math nodes, but not prices or code', () => {
    const html = markdownToNoteHtml('Pay $5 and $10. Then $a+b$ and `$c$`.')
    expect(html.match(/data-math/g)).toHaveLength(1)
    expect(html).toContain('data-latex="a+b"')
    expect(html).toContain('<code>$c$</code>')
    expect(html).toContain('$5 and $10')
  })
})
