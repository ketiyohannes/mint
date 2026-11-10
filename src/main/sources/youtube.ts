import { formatTimestamp, normalizeSections, type RawBlock, type RawSection } from './normalize'
import type { ImportedSource } from './types'

export const NO_TRANSCRIPT_MESSAGE = 'No transcript is available for this video yet. Paste one from the Library to read along.'

/** Sections close once they reach this length at a sentence end... */
const SECTION_MIN_SECONDS = 60
/** ...and always close at this length. */
const SECTION_MAX_SECONDS = 90
/** Untimed transcripts are chunked into cues of roughly this many words. */
const CUE_WORDS = 120
/** How long one call to YouTube may take before the import gives up on it. */
const YOUTUBE_TIMEOUT_MS = 30_000

/** Rejects when `work` has not settled in time: youtubei.js has no timeout of its own, and a stalled call would leave the import running forever. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'])

/** Extracts the 11-character video id from any common YouTube link form. */
export function parseYouTubeId(url: string): string | null {
  const trimmed = url.trim()
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const segments = parsed.pathname.split('/').filter(Boolean)

  let candidate: string | null | undefined
  if (host === 'youtu.be') {
    candidate = segments[0]
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === 'watch') candidate = parsed.searchParams.get('v')
    else if (['embed', 'shorts', 'live', 'v', 'e'].includes(segments[0] ?? '')) candidate = segments[1]
  }
  return candidate && VIDEO_ID.test(candidate) ? candidate : null
}

// ---------------------------------------------------------------------------
// Transcript grouping
// ---------------------------------------------------------------------------

interface Cue {
  t: number
  text: string
}

/**
 * Groups timed cues into sections of roughly 60-90 seconds, preferring to
 * break after a cue that ends a sentence. Labels are the section start time.
 */
function groupCues(cues: Cue[]): RawSection[] {
  const sections: RawSection[] = []
  let current: RawSection | undefined
  let previousText = ''

  for (const cue of cues) {
    const elapsed = current ? cue.t - (current.t ?? 0) : 0
    const shouldBreak = elapsed >= SECTION_MAX_SECONDS || (elapsed >= SECTION_MIN_SECONDS && /[.!?]["')\]]*$/.test(previousText.trim()))
    if (!current || shouldBreak) {
      current = { label: formatTimestamp(cue.t), t: cue.t, blocks: [] }
      sections.push(current)
    }
    current.blocks.push({ type: 'cue', text: cue.text, t: cue.t })
    previousText = cue.text
  }
  return sections
}

// ---------------------------------------------------------------------------
// Pasted transcripts
// ---------------------------------------------------------------------------

/**
 * A leading timestamp: `0:05`, `00:01:23`, `[12:30]`, `(1:02:03)`, `12:30 -`,
 * and SRT/VTT cue timings (`00:00:01,000 --> 00:00:04,000`).
 */
const TIMESTAMP_LINE = /^\s*[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d{1,3})?[\])]?(?:\s*-->\s*[\d:.,]+)?\s*(?:[-–—:|]\s*)?(.*)$/

function timestampToSeconds(stamp: string): number {
  return stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

function chunkUntimed(text: string): RawBlock[] {
  const words = text.split(/\s+/).filter(Boolean)
  const blocks: RawBlock[] = []
  let current: string[] = []
  for (const word of words) {
    current.push(word)
    // Prefer to end a cue at a sentence boundary; force a break if none comes.
    if ((current.length >= CUE_WORDS && /[.!?]["')\]]*$/.test(word)) || current.length >= CUE_WORDS * 1.5) {
      blocks.push({ type: 'cue', text: current.join(' ') })
      current = []
    }
  }
  if (current.length) blocks.push({ type: 'cue', text: current.join(' ') })
  return blocks
}

/**
 * Parses a transcript the learner pasted. Lines with leading timestamps
 * become timed cues grouped like a fetched transcript; untimed lines are
 * appended to the cue before them (YouTube's "show transcript" copy puts the
 * timestamp on its own line). Without timestamps the text is chunked into
 * ~120-word cues in one "Transcript" section.
 */
export function transcriptFromText(text: string): RawSection[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const timedLines = lines.filter((line) => TIMESTAMP_LINE.test(line)).length

  if (timedLines < 2) {
    const blocks = chunkUntimed(text)
    return blocks.length ? [{ label: 'Transcript', blocks }] : []
  }

  const cues: Cue[] = []
  let pending: Cue | null = null
  const flush = (): void => {
    if (pending && pending.text.trim()) cues.push(pending)
    pending = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line === 'WEBVTT' || /^\d+$/.test(line)) continue // blank, VTT header, SRT index
    const match = line.match(TIMESTAMP_LINE)
    if (match) {
      flush()
      pending = { t: timestampToSeconds(match[1]), text: match[2] }
    } else if (pending) {
      pending.text = pending.text ? `${pending.text} ${line}` : line
    } else {
      // Text before the first timestamp belongs to the start of the video.
      pending = { t: 0, text: line }
    }
  }
  flush()
  return groupCues(cues)
}

// ---------------------------------------------------------------------------
// Fetching from YouTube
// ---------------------------------------------------------------------------

/** The subset of a youtubei.js transcript segment we read. */
export interface YouTubeTranscriptItem {
  /** `TranscriptSegment` for cues; `TranscriptSectionHeader` for chapter titles. */
  type: string
  start_ms: string
  snippet: { text?: string }
}

/** The subset of youtubei.js `VideoInfo` we use. */
export interface YouTubeVideoInfo {
  basic_info: {
    title?: string
    author?: string
    channel?: { name: string } | null
  }
  getTranscript(): Promise<{
    transcript: {
      content: { body: { initial_segments: ArrayLike<YouTubeTranscriptItem> } | null } | null
    }
  }>
}

/** A caption track as listed by the player response. */
export interface YouTubeCaptionTrack {
  base_url: string
  language_code: string
  kind?: string
}

/** The subset of youtubei.js `Innertube` we use; injectable for tests. */
export interface YouTubeClient {
  getInfo(videoId: string): Promise<YouTubeVideoInfo>
  /** Used for the caption-track fallback (the mobile clients still list tracks). */
  getBasicInfo?(videoId: string, options: { client: 'ANDROID' | 'IOS' }): Promise<{ captions?: { caption_tracks?: YouTubeCaptionTrack[] } | null }>
}

let defaultClient: Promise<YouTubeClient> | null = null

/** Lazily creates one shared Innertube session (the library is large; load it on first use). */
function getDefaultClient(): Promise<YouTubeClient> {
  defaultClient ??= import('youtubei.js')
    .then(({ Innertube }) => Innertube.create({ retrieve_player: false }))
    .then((client): YouTubeClient => client)
    .catch((err: unknown) => {
      defaultClient = null // allow a retry after a transient failure
      throw err
    })
  return defaultClient
}

async function fetchTranscript(info: YouTubeVideoInfo, timeoutMs: number): Promise<Cue[]> {
  try {
    const result = await withTimeout(info.getTranscript(), timeoutMs, 'Reading the transcript')
    const segments = Array.from(result.transcript.content?.body?.initial_segments ?? [])
    return segments
      .filter((s) => s.type === 'TranscriptSegment')
      .map((s) => ({ t: Number(s.start_ms) / 1000, text: s.snippet.text ?? '' }))
      .filter((cue) => Number.isFinite(cue.t) && cue.text.trim() !== '')
  } catch {
    // Captions disabled, region-locked, or the panel changed shape: treat as missing.
    return []
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENTITIES[code.toLowerCase()] ?? m
  })
}

/**
 * Parses YouTube timedtext XML in either format:
 *   format 3: <p t="1230" d="2000">text <s>more</s></p>   (milliseconds)
 *   legacy:   <text start="1.23" dur="2.0">text</text>     (seconds)
 */
export function parseTimedText(xml: string): Cue[] {
  const cues: Cue[] = []
  const strip = (inner: string) =>
    decodeEntities(decodeEntities(inner.replace(/<[^>]+>/g, '')))
      .replace(/\s+/g, ' ')
      .trim()
  for (const m of xml.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = strip(m[2])
    if (text) cues.push({ t: Number(m[1]) / 1000, text })
  }
  if (cues.length) return cues
  for (const m of xml.matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = strip(m[2])
    if (text) cues.push({ t: Number(m[1]), text })
  }
  return cues
}

/** Prefer human-made English captions, then auto-generated English, then anything. */
function pickTrack(tracks: YouTubeCaptionTrack[]): YouTubeCaptionTrack | undefined {
  const en = tracks.filter((t) => t.language_code?.toLowerCase().startsWith('en'))
  return en.find((t) => t.kind !== 'asr') ?? en[0] ?? tracks.find((t) => t.kind !== 'asr') ?? tracks[0]
}

/**
 * Fallback when the transcript panel is unavailable: read the caption track
 * listed by a mobile client's player response and fetch its timedtext.
 */
async function fetchCaptionTrack(client: YouTubeClient, videoId: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Cue[]> {
  if (!client.getBasicInfo) return []
  for (const c of ['ANDROID', 'IOS'] as const) {
    try {
      const info = await withTimeout(client.getBasicInfo(videoId, { client: c }), timeoutMs, 'Reading the captions')
      const track = pickTrack(info.captions?.caption_tracks ?? [])
      if (!track?.base_url) continue
      const url = new URL(track.base_url)
      if (!/(^|\.)youtube\.com$/.test(url.hostname)) continue // only YouTube's own timedtext endpoint
      const res = await fetchImpl(url.href, { signal: AbortSignal.timeout(Math.min(20_000, timeoutMs)) })
      if (!res.ok) continue
      const cues = parseTimedText(await res.text())
      if (cues.length) return cues
    } catch {
      // Try the next client.
    }
  }
  return []
}

/**
 * Imports a YouTube video's transcript. Throws when the video itself cannot
 * be loaded; a missing transcript yields a placeholder with `needsTranscript`.
 */
export async function importYouTube(url: string, opts: { innertube?: YouTubeClient; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<ImportedSource> {
  const videoId = parseYouTubeId(url)
  if (!videoId) throw new Error('This does not look like a YouTube video link.')
  const timeoutMs = opts.timeoutMs ?? YOUTUBE_TIMEOUT_MS

  let info: YouTubeVideoInfo
  let client: YouTubeClient
  try {
    client = opts.innertube ?? (await withTimeout(getDefaultClient(), timeoutMs, 'Connecting to YouTube'))
    info = await withTimeout(client.getInfo(videoId), timeoutMs, 'Loading the video')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not load this YouTube video (${reason}).`)
  }

  const title = info.basic_info.title?.trim() || `YouTube video ${videoId}`
  const author = (info.basic_info.author ?? info.basic_info.channel?.name ?? '').trim()
  let cues = await fetchTranscript(info, timeoutMs)
  if (cues.length === 0) cues = await fetchCaptionTrack(client, videoId, opts.fetchImpl ?? fetch, timeoutMs)

  const base = {
    kind: 'youtube' as const,
    title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    domain: 'youtube.com',
    videoId,
    ...(author ? { author } : {})
  }

  if (cues.length === 0) {
    return {
      ...base,
      sections: normalizeSections([{ label: '00:00', t: 0, blocks: [{ type: 'paragraph', text: NO_TRANSCRIPT_MESSAGE }] }]),
      needsTranscript: true
    }
  }
  return { ...base, sections: normalizeSections(groupCues(cues)) }
}
