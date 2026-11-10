import { describe, expect, it } from 'vitest'
import { importUrl } from '../../src/main/sources'
import { importYouTube, parseTimedText, withTimeout, type YouTubeClient } from '../../src/main/sources/youtube'

describe('YouTube caption-track fallback', () => {
  it('parses timedtext format 3 (ms, nested spans, entities)', () => {
    const xml = '<timedtext format="3"><body><p t="0" d="1000">Hello &amp;amp; <s>welcome</s></p><p t="2500" d="900"></p><p t="3200" d="900">It&#39;s &quot;eigen&quot;</p></body></timedtext>'
    expect(parseTimedText(xml)).toEqual([
      { t: 0, text: 'Hello & welcome' },
      { t: 3.2, text: 'It\'s "eigen"' }
    ])
  })

  it('parses the legacy transcript format (seconds)', () => {
    const xml = '<transcript><text start="0" dur="1.5">First</text><text start="19.92" dur="3">Second line</text></transcript>'
    expect(parseTimedText(xml)).toEqual([
      { t: 0, text: 'First' },
      { t: 19.92, text: 'Second line' }
    ])
  })

  it('falls back to the mobile caption track when the transcript panel fails', async () => {
    const client: YouTubeClient = {
      getInfo: async () => ({
        basic_info: { title: 'Lecture', author: 'Chan' },
        getTranscript: async () => {
          throw new Error('400')
        }
      }),
      getBasicInfo: async (_id, { client }) =>
        client === 'ANDROID'
          ? {
              captions: {
                caption_tracks: [
                  { base_url: 'https://www.youtube.com/api/timedtext?v=x&lang=fr', language_code: 'fr' },
                  { base_url: 'https://www.youtube.com/api/timedtext?v=x&lang=en', language_code: 'en' }
                ]
              }
            }
          : { captions: null }
    }
    const fetched: string[] = []
    const fetchImpl = (async (url: string) => {
      fetched.push(url)
      return new Response('<timedtext format="3"><body><p t="0" d="1">Eigenvectors are special.</p><p t="61000" d="1">Later part.</p></body></timedtext>')
    }) as typeof fetch
    const s = await importYouTube('https://youtu.be/PFDu9oVAE-g', { innertube: client, fetchImpl })
    expect(fetched).toEqual(['https://www.youtube.com/api/timedtext?v=x&lang=en'])
    expect(s.needsTranscript).toBeFalsy()
    expect(s.sections.flatMap((x) => x.blocks).map((b) => b.text)).toEqual(['Eigenvectors are special.', 'Later part.'])
  })

  it('never fetches caption URLs outside youtube.com', async () => {
    const client: YouTubeClient = {
      getInfo: async () => ({ basic_info: { title: 'T' }, getTranscript: async () => ({ transcript: { content: null } }) }),
      getBasicInfo: async () => ({ captions: { caption_tracks: [{ base_url: 'https://evil.example/x', language_code: 'en' }] } })
    }
    let called = false
    const s = await importYouTube('https://youtu.be/PFDu9oVAE-g', {
      innertube: client,
      fetchImpl: (async () => {
        called = true
        return new Response('')
      }) as typeof fetch
    })
    expect(called).toBe(false)
    expect(s.needsTranscript).toBe(true)
  })
})

describe('YouTube calls are bounded', () => {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined)

  it('gives up on a video that never loads instead of importing forever', async () => {
    const client: YouTubeClient = { getInfo: () => never() }
    await expect(importYouTube('https://youtu.be/PFDu9oVAE-g', { innertube: client, timeoutMs: 20 })).rejects.toThrow(/Could not load this YouTube video \(Loading the video took longer than/)
  })

  it('treats a transcript that never arrives as missing', async () => {
    const client: YouTubeClient = { getInfo: async () => ({ basic_info: { title: 'Lecture' }, getTranscript: () => never() }) }
    const s = await importYouTube('https://youtu.be/PFDu9oVAE-g', { innertube: client, timeoutMs: 20 })
    expect(s.title).toBe('Lecture')
    expect(s.needsTranscript).toBe(true)
  })

  it('withTimeout passes a result or an error through and clears its timer', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'x')).resolves.toBe(7)
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
  })

  it('a URL import fetches captions through the injected fetch', async () => {
    const client: YouTubeClient = {
      getInfo: async () => ({ basic_info: { title: 'Lecture' }, getTranscript: async () => ({ transcript: { content: null } }) }),
      getBasicInfo: async () => ({ captions: { caption_tracks: [{ base_url: 'https://www.youtube.com/api/timedtext?v=x&lang=en', language_code: 'en' }] } })
    }
    const fetched: string[] = []
    const fetchImpl = (async (url: string) => {
      fetched.push(url)
      return new Response('<timedtext format="3"><body><p t="0" d="1">From the injected fetch.</p></body></timedtext>')
    }) as typeof fetch
    const s = await importUrl('https://youtu.be/PFDu9oVAE-g', { innertube: client, fetchImpl })
    expect(fetched).toEqual(['https://www.youtube.com/api/timedtext?v=x&lang=en'])
    expect(s.sections[0].blocks[0].text).toBe('From the injected fetch.')
  })
})
