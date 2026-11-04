import { describe, expect, it } from 'vitest'
import { quoteMessage, splitQuoted, titleText } from '../../src/shared/quote'

describe('quoted passages in the main chat', () => {
  it('round-trips a multi-line passage, its source and the question', () => {
    const text = quoteMessage('Those are the eigenvectors.\nThey keep their direction.', 'Strang · 6.1', 'Why only these?')
    expect(text).toBe('> Those are the eigenvectors.\n> They keep their direction.\n> — Strang · 6.1\n\nWhy only these?')
    expect(splitQuoted(text)).toEqual({ quote: 'Those are the eigenvectors.\nThey keep their direction.', source: 'Strang · 6.1', body: 'Why only these?' })
  })

  it('leaves ordinary messages alone', () => {
    expect(splitQuoted('what is a basis?')).toEqual({ quote: null, source: null, body: 'what is a basis?' })
    expect(splitQuoted('a > b, right?').quote).toBeNull()
  })

  it('handles a quote without a source line', () => {
    expect(splitQuoted('> just this\n\nexplain')).toEqual({ quote: 'just this', source: null, body: 'explain' })
  })

  it('titles a chat by its question, falling back to the passage', () => {
    expect(titleText(quoteMessage('A long passage', 'Book', 'What does this mean?'))).toBe('What does this mean?')
    expect(titleText('> Only a passage\n> — Book')).toBe('Only a passage')
    expect(titleText('  plain   question ')).toBe('plain question')
  })
})
