import { describe, expect, it } from 'vitest'
import { normalizeSections } from '../../src/main/sources/normalize'
import { importYouTube, NO_TRANSCRIPT_MESSAGE, parseYouTubeId, transcriptFromText, type YouTubeClient, type YouTubeTranscriptItem, type YouTubeVideoInfo } from '../../src/main/sources/youtube'

const ID = 'dQw4w9WgXcQ'

describe('parseYouTubeId', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?feature=share&v=${ID}&t=42s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=RD`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc&t=10`,
    `https://www.youtube.com/embed/${ID}?start=5`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `youtube.com/watch?v=${ID}`,
    `  https://youtu.be/${ID}  `
  ])('parses %s', (url) => {
    expect(parseYouTubeId(url)).toBe(ID)
  })

  it.each([
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/@channel',
    `https://example.com/watch?v=${ID}`,
    `https://youtu.be.evil.com/${ID}`,
    'not a url at all'
  ])('rejects %s', (url) => {
    expect(parseYouTubeId(url)).toBeNull()
  })
})

describe('transcriptFromText', () => {
  it('parses timestamped lines in several formats and groups ~60-90 s sections', () => {
    const text = [
      '0:00 Welcome to the lecture.',
      '[0:30] Today we cover eigenvalues',
      'and eigenvectors.',
      '(0:55) - First, a definition.',
      '01:05 – The next idea starts here.',
      '1:40 | More content without a full stop',
      '2:20 Still going',
      '00:03:10 A new sentence.',
      '1:02:03 Much later.'
    ].join('\n')

    const sections = transcriptFromText(text)
    expect(sections.map((s) => [s.label, s.t])).toEqual([
      ['00:00', 0],
      ['01:05', 65],
      ['03:10', 190],
      ['1:02:03', 3723]
    ])
    expect(sections[0].blocks).toEqual([
      { type: 'cue', text: 'Welcome to the lecture.', t: 0 },
      { type: 'cue', text: 'Today we cover eigenvalues and eigenvectors.', t: 30 },
      { type: 'cue', text: 'First, a definition.', t: 55 }
    ])
    // 1:40 does not end a sentence and is < 90 s into the section, so 2:20 stays too.
    expect(sections[1].blocks.map((b) => b.t)).toEqual([65, 100, 140])
  })

  it('handles YouTube copy-paste (timestamp on its own line) and SRT', () => {
    const youtubeCopy = transcriptFromText('0:00\nhello there\n0:04\ngeneral idea\n')
    expect(youtubeCopy[0].blocks).toEqual([
      { type: 'cue', text: 'hello there', t: 0 },
      { type: 'cue', text: 'general idea', t: 4 }
    ])

    const srt = transcriptFromText('1\n00:00:01,000 --> 00:00:04,000\nFirst caption\n\n2\n00:00:05,500 --> 00:00:08,000\nSecond caption\n')
    expect(srt[0].blocks).toEqual([
      { type: 'cue', text: 'First caption', t: 1 },
      { type: 'cue', text: 'Second caption', t: 5 }
    ])
  })

  it('chunks untimed text into ~120-word cues in one section', () => {
    const sentence = 'This is a sentence with exactly ten words in it. '
    const sections = transcriptFromText(sentence.repeat(30)) // 300 words
    expect(sections).toHaveLength(1)
    expect(sections[0].label).toBe('Transcript')
    const counts = sections[0].blocks.map((b) => b.text.split(' ').length)
    expect(counts).toEqual([120, 120, 60])
    for (const block of sections[0].blocks) {
      expect(block.type).toBe('cue')
      expect(block.t).toBeUndefined()
    }
  })

  it('returns no sections for empty text and normalizes cleanly', () => {
    expect(transcriptFromText('  \n ')).toEqual([])
    const normalized = normalizeSections(transcriptFromText('0:00 a.\n0:10 b.'))
    expect(normalized[0].blocks.map((b) => b.id)).toEqual(['s0b0', 's0b1'])
  })
})

function segment(ms: number, text: string): YouTubeTranscriptItem {
  return { type: 'TranscriptSegment', start_ms: String(ms), snippet: { text } }
}

function fakeClient(info: Partial<YouTubeVideoInfo> & Pick<YouTubeVideoInfo, 'getTranscript'>): YouTubeClient & {
  requested: string[]
} {
  const requested: string[] = []
  return {
    requested,
    async getInfo(videoId: string) {
      requested.push(videoId)
      return { basic_info: { title: 'Essence of Linear Algebra', author: '3Blue1Brown' }, ...info }
    }
  }
}

describe('importYouTube', () => {
  it('imports transcript cues grouped into timed sections', async () => {
    const segments: YouTubeTranscriptItem[] = [{ type: 'TranscriptSectionHeader', start_ms: '0', snippet: { text: 'Intro' } }]
    for (let s = 0; s < 200; s += 10) segments.push(segment(s * 1000 + 500, `Sentence at ${s}.`))
    const client = fakeClient({
      getTranscript: async () => ({ transcript: { content: { body: { initial_segments: segments } } } })
    })

    const source = await importYouTube(`https://youtu.be/${ID}?t=3`, { innertube: client })

    expect(client.requested).toEqual([ID])
    expect(source).toMatchObject({
      kind: 'youtube',
      title: 'Essence of Linear Algebra',
      author: '3Blue1Brown',
      videoId: ID,
      url: `https://www.youtube.com/watch?v=${ID}`,
      domain: 'youtube.com'
    })
    expect(source.needsTranscript).toBeUndefined()
    expect(source.sections.map((s) => [s.id, s.label, s.t])).toEqual([
      ['s0', '00:00', 0.5],
      ['s1', '01:00', 60.5],
      ['s2', '02:00', 120.5],
      ['s3', '03:00', 180.5]
    ])
    expect(source.sections[0].blocks[0]).toEqual({ id: 's0b0', type: 'cue', text: 'Sentence at 0.', t: 0.5 })
    expect(source.sections.flatMap((s) => s.blocks).some((b) => b.text === 'Intro')).toBe(false)
  })

  it('falls back to a placeholder when the transcript is unavailable', async () => {
    const client = fakeClient({
      basic_info: { title: 'No captions', channel: { name: 'Some Channel' } },
      getTranscript: async () => {
        throw new Error('Transcript panel not found')
      }
    })
    const source = await importYouTube(`https://www.youtube.com/watch?v=${ID}`, { innertube: client })

    expect(source.needsTranscript).toBe(true)
    expect(source.author).toBe('Some Channel')
    expect(source.sections).toEqual([{ id: 's0', label: '00:00', t: 0, blocks: [{ id: 's0b0', type: 'paragraph', text: NO_TRANSCRIPT_MESSAGE }] }])
  })

  it('treats an empty transcript as unavailable', async () => {
    const client = fakeClient({
      getTranscript: async () => ({ transcript: { content: { body: { initial_segments: [] } } } })
    })
    const source = await importYouTube(`https://youtu.be/${ID}`, { innertube: client })
    expect(source.needsTranscript).toBe(true)
  })

  it('throws when the video itself cannot be loaded', async () => {
    const client: YouTubeClient = {
      getInfo: async () => {
        throw new Error('Video unavailable')
      }
    }
    await expect(importYouTube(`https://youtu.be/${ID}`, { innertube: client })).rejects.toThrow('Could not load this YouTube video (Video unavailable).')
  })

  it('rejects non-video links', async () => {
    await expect(importYouTube('https://www.youtube.com/@channel', {})).rejects.toThrow(/YouTube video link/)
  })
})
