import { describe, expect, it } from 'vitest'
import { quoteToRanges } from '../../src/renderer/src/lib/anchors'

/** PDF page-view selections map back to the normalized text's block ranges. */
describe('quoteToRanges', () => {
  const blocks = [
    { id: 'a', text: 'Most vectors change direction when a matrix multiplies them.' },
    { id: 'b', text: 'A few special vectors are different: they stay on the same line.' }
  ]

  it('finds a quote inside one block, tolerant of case and punctuation', () => {
    const [r] = quoteToRanges(blocks, 'MATRIX multiplies them')
    expect(r.blockId).toBe('a')
    expect(blocks[0].text.slice(r.start, r.end)).toBe('matrix multiplies them')
  })

  it('spans blocks when the selection crosses a paragraph', () => {
    const r = quoteToRanges(blocks, 'multiplies them. A few special')
    expect(r.map((x) => x.blockId)).toEqual(['a', 'b'])
    expect(blocks[0].text.slice(r[0].start, r[0].end)).toBe('multiplies them')
    expect(blocks[1].text.slice(r[1].start, r[1].end)).toBe('A few special')
  })

  it('falls back to the longest matching prefix, and to nothing for unrelated text', () => {
    const r = quoteToRanges(blocks, 'they stay on the same line and then something extracted differently')
    expect(blocks[1].text.slice(r[0].start, r[0].end)).toBe('they stay on the same line')
    expect(quoteToRanges(blocks, 'completely unrelated words here')).toEqual([])
    expect(quoteToRanges(blocks, '  ')).toEqual([])
  })

  it('matches letters outside the basic plane (the math italics of many PDFs)', () => {
    const math = [{ id: 'm', text: 'Let 𝑥 be an eigenvector of 𝐴 and λ its eigenvalue.' }]
    const [whole] = quoteToRanges(math, 'eigenvector of 𝐴 and')
    expect(math[0].text.slice(whole.start, whole.end)).toBe('eigenvector of 𝐴 and')
    const [ending] = quoteToRanges(math, 'Let 𝑥')
    expect(math[0].text.slice(ending.start, ending.end)).toBe('Let 𝑥')
  })
})
