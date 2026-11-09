import { describe, expect, it } from 'vitest'
import { releaseNotes } from '../../src/main/updater'

describe('update release notes', () => {
  it('shows the release notes GitHub sends as HTML as plain text in the app', () => {
    const notes = releaseNotes({
      releaseNotes: '<h2>What&#39;s new</h2><ul><li>Drag the lesson anywhere</li><li>A focus timer &amp; breaks</li></ul><p>Thanks!<br/>— mint</p>'
    })
    expect(notes).toBe("What's new\n• Drag the lesson anywhere\n• A focus timer & breaks\n\nThanks!\n— mint")
  })

  it('has nothing to show for empty notes, and caps long ones', () => {
    expect(releaseNotes({ releaseNotes: null })).toBeUndefined()
    expect(releaseNotes({ releaseNotes: '<p> </p>' })).toBeUndefined()
    expect(releaseNotes({ releaseNotes: 'x'.repeat(3000) })!.length).toBe(2001)
  })
})
