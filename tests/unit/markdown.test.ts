import { describe, expect, it } from 'vitest'
import { extractMath, type MathItem } from '../../src/renderer/src/lib/markdown'

/** Formulas are swapped for tokens before the markdown is parsed; code must come through untouched. */
describe('extractMath', () => {
  const run = (text: string) => {
    const math: MathItem[] = []
    return { out: extractMath(text, math), math }
  }

  it('takes inline and display formulas out of prose', () => {
    const { out, math } = run('The roots of $x^2 = 4$ are shown below.\n\n$$x = \\pm 2$$')
    // Display formulas are taken first, so theirs are the lower numbers.
    expect(out).toBe('The roots of @@M1@@ are shown below.\n\n@@M0@@')
    expect(math).toEqual([
      { tex: 'x = \\pm 2', display: true },
      { tex: 'x^2 = 4', display: false }
    ])
  })

  it('reads \\( \\) and \\[ \\] as formulas too', () => {
    const { out, math } = run('Inline \\(a+b\\) and display \\[c\\]')
    expect(out).toBe('Inline @@M1@@ and display @@M0@@')
    expect(math).toEqual([
      { tex: 'c', display: true },
      { tex: 'a+b', display: false }
    ])
  })

  it('leaves dollars inside an inline code span alone', () => {
    const { out, math } = run('Type `$x^2$` for a formula, like $y$.')
    expect(out).toBe('Type `$x^2$` for a formula, like @@M0@@.')
    expect(math).toEqual([{ tex: 'y', display: false }])
  })

  it('leaves template literals and shell variables in a fenced block alone', () => {
    const js = '```js\nconst name = `${first}${last}`\n```'
    const sh = '```bash\necho $HOME/$USER and $$\nkill $$\n```'
    expect(run(js)).toEqual({ out: js, math: [] })
    expect(run(sh)).toEqual({ out: sh, math: [] })
  })

  it('leaves a fenced block that is still streaming alone', () => {
    const open = 'Here it is:\n\n```sh\ncp $SRC/$FILE'
    expect(run(open)).toEqual({ out: open, math: [] })
  })

  it('still finds formulas before, between and after code', () => {
    const { out, math } = run('$a$ then `$b$` then $c$\n\n~~~\n$d$ $e$\n~~~\n\nand $f$')
    expect(out).toBe('@@M0@@ then `$b$` then @@M1@@\n\n~~~\n$d$ $e$\n~~~\n\nand @@M2@@')
    expect(math.map((m) => m.tex)).toEqual(['a', 'c', 'f'])
  })

  it('does not read prices or escaped dollars as formulas', () => {
    expect(run('It costs $5 and $10.').math).toEqual([])
    expect(run('Between $5 and $ 10, or \\$3$.').math).toEqual([])
  })
})
