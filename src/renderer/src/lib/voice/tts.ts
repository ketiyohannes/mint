import { toSpeechChunks, type Directive, type SpeechChunk } from '@shared/directives'
import { api } from '../api'

/**
 * Speaks a tutor reply sentence by sentence. Each chunk carries the diagram
 * directives that appear in it, fired as the chunk starts, so the visual
 * pointer moves in step with the voice.
 */
export interface SpeakOptions {
  engine: 'system' | 'openai'
  voice: string
  rate: number
  onChunk?: (chunk: SpeechChunk, index: number) => void
  onDirective?: (d: Directive) => void
  onEnd?: () => void
}

export interface Speech {
  cancel(): void
  done: Promise<void>
}

export function pickSystemVoice(name: string): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices()
  if (name) {
    const exact = voices.find((v) => v.name === name)
    if (exact) return exact
  }
  const en = voices.filter((v) => v.lang.startsWith('en'))
  // Prefer the higher-quality voices macOS ships when they are installed.
  return (
    en.find((v) => /premium/i.test(v.name)) ??
    en.find((v) => /enhanced/i.test(v.name)) ??
    en.find((v) => /^(Ava|Zoe|Samantha|Allison|Evan|Nathan|Serena|Daniel)/.test(v.name)) ??
    en.find((v) => v.default) ??
    en[0]
  )
}

export function speak(text: string, opts: SpeakOptions): Speech {
  const chunks = toSpeechChunks(text)
  let cancelled = false
  let currentAudio: HTMLAudioElement | null = null
  const cancel = () => {
    cancelled = true
    speechSynthesis.cancel()
    if (currentAudio) {
      currentAudio.pause()
      currentAudio.src = ''
    }
  }

  const fire = (chunk: SpeechChunk, i: number) => {
    opts.onChunk?.(chunk, i)
    chunk.directives.forEach((d) => opts.onDirective?.(d))
  }

  const done = (async () => {
    if (opts.engine === 'openai') {
      // Fetch the next chunk while the current one plays.
      let nextAudio: Promise<ArrayBuffer> | null = chunks[0] ? api.voice.speak(chunks[0].speak, opts.voice) : null
      for (let i = 0; i < chunks.length && !cancelled; i++) {
        const bytes = await nextAudio!
        nextAudio = chunks[i + 1] ? api.voice.speak(chunks[i + 1].speak, opts.voice) : null
        if (cancelled) break
        fire(chunks[i], i)
        const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
        currentAudio = new Audio(url)
        currentAudio.playbackRate = opts.rate
        await new Promise<void>((resolve) => {
          currentAudio!.onended = () => resolve()
          currentAudio!.onerror = () => resolve()
          void currentAudio!.play().catch(() => resolve())
        })
        URL.revokeObjectURL(url)
      }
    } else {
      const voice = pickSystemVoice(opts.voice)
      for (let i = 0; i < chunks.length && !cancelled; i++) {
        fire(chunks[i], i)
        await new Promise<void>((resolve) => {
          const u = new SpeechSynthesisUtterance(chunks[i].speak)
          if (voice) u.voice = voice
          u.rate = opts.rate
          u.onend = () => resolve()
          u.onerror = () => resolve()
          speechSynthesis.speak(u)
        })
      }
    }
    opts.onEnd?.()
  })()
  return { cancel, done }
}
