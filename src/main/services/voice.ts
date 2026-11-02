import type { Kernel } from './kernel'
import { userError } from './kernel'

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']

/**
 * Cloud speech via OpenAI (optional; used only when the learner adds a key).
 * The default path is fully local: Whisper in the renderer for speech-to-text
 * and the system voice for text-to-speech.
 */
export class VoiceService {
  constructor(
    private readonly k: Kernel,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async key(): Promise<string> {
    const key = await this.k.settings.getSecret('openai')
    if (!key) throw userError('Add an OpenAI API key in Settings to use cloud voice, or switch to the local voice engines.')
    return key
  }

  async transcribe(wav: ArrayBuffer): Promise<string> {
    if (!(wav instanceof ArrayBuffer) || wav.byteLength < 1000) throw userError('No audio was captured.')
    if (wav.byteLength > 25 * 1024 * 1024) throw userError('That recording is too long. Keep voice questions under a few minutes.')
    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', 'gpt-4o-mini-transcribe')
    const res = await this.fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.key()}` },
      body: form,
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw userError(`Transcription failed (${res.status}). ${await safeText(res)}`)
    const json = (await res.json()) as { text?: string }
    return String(json.text ?? '').trim()
  }

  async speak(text: string, voice: string): Promise<ArrayBuffer> {
    const input = text.trim().slice(0, 4000)
    if (!input) throw userError('Nothing to say.')
    const res = await this.fetchImpl('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: OPENAI_VOICES.includes(voice) ? voice : 'coral',
        input,
        instructions: 'You are a warm, clear tutor. Speak at a relaxed teaching pace and pause briefly between ideas.',
        response_format: 'mp3'
      }),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw userError(`Speech failed (${res.status}). ${await safeText(res)}`)
    return res.arrayBuffer()
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text()
    const parsed = JSON.parse(t) as { error?: { message?: string } }
    return parsed.error?.message?.slice(0, 200) ?? ''
  } catch {
    return ''
  }
}

export { OPENAI_VOICES }
