import { describe, expect, it } from 'vitest'
import { checkDraft, clearSessionDrafts, hideCheckDraft, savedDraft, setCheckDraft } from '../../src/renderer/src/views/study/drafts'

/** A half-written check answer outlives its box; tutors see it only while the box is on screen. */
describe('check drafts', () => {
  it('keeps an answer per lesson and check, and shows the tutors the one on screen', () => {
    setCheckDraft('ses1', 'explain', 'A direction the matrix only stretches')
    expect(checkDraft('ses1')).toEqual({ kind: 'explain', text: 'A direction the matrix only stretches' })
    expect(checkDraft('ses2')).toBeUndefined()
    expect(checkDraft(undefined)).toBeUndefined()

    // The box leaves the screen (another step, the dock closed): kept, but no longer shown.
    hideCheckDraft('ses1', 'explain')
    expect(checkDraft('ses1')).toBeUndefined()
    expect(savedDraft('ses1', 'explain')).toBe('A direction the matrix only stretches')

    // Another check of the same lesson has its own answer.
    setCheckDraft('ses1', 'apply', '')
    expect(checkDraft('ses1')).toBeUndefined()
    setCheckDraft('ses1', 'apply', 'Scale it by two')
    expect(checkDraft('ses1')).toEqual({ kind: 'apply', text: 'Scale it by two' })
    expect(savedDraft('ses1', 'explain')).toBe('A direction the matrix only stretches')
  })

  it('drops an answer once it is emptied (a pass), and all of a lesson when it ends', () => {
    setCheckDraft('ses3', 'explain', 'first')
    setCheckDraft('ses3', 'explain', '   ')
    expect(savedDraft('ses3', 'explain')).toBe('')
    expect(checkDraft('ses3')).toBeUndefined()

    setCheckDraft('ses3', 'distinguish', 'second')
    clearSessionDrafts('ses3')
    expect(savedDraft('ses3', 'distinguish')).toBe('')
    expect(checkDraft('ses3')).toBeUndefined()
  })
})
