import { useCallback, useEffect, useRef, useState } from 'react'
import type { Directive } from '@shared/directives'
import { startRecording, type Recording } from '../../lib/voice/audio'
import { onModelProgress, preloadLocalWhisper, transcribe } from '../../lib/voice/stt'
import { speak, type Speech } from '../../lib/voice/tts'
import { errorMessage } from '../../lib/api'
import type { SettingsView } from '@shared/types'

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'speaking'

interface Options {
  settings: SettingsView | null
  onTranscript: (text: string) => void
  onDirective: (d: Directive) => void
  onError: (message: string) => void
}

/** Push-to-talk (hold Space or click the mic) and synced spoken replies. */
export function useVoice({ settings, onTranscript, onDirective, onError }: Options) {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [caption, setCaption] = useState<{ text: string; messageId: string } | null>(null)
  const [modelPct, setModelPct] = useState<number | null>(null)
  const recording = useRef<Recording | null>(null)
  const speech = useRef<Speech | null>(null)
  const starting = useRef(false)
  const cb = useRef({ onTranscript, onDirective, onError })
  cb.current = { onTranscript, onDirective, onError }
  const engine = settings?.sttEngine ?? 'local-whisper'

  useEffect(() => onModelProgress((p) => setModelPct(p >= 100 ? null : p)), [])

  const stopSpeaking = useCallback(() => {
    speech.current?.cancel()
    speech.current = null
    setCaption(null)
    setStatus((s) => (s === 'speaking' ? 'idle' : s))
  }, [])

  const start = useCallback(async () => {
    if (recording.current || starting.current) return
    stopSpeaking() // barge-in: talking interrupts the tutor
    // Start loading the local model while the learner is still talking.
    if (engine === 'local-whisper') preloadLocalWhisper()
    starting.current = true
    try {
      recording.current = await startRecording()
      setStatus('recording')
    } catch (err) {
      cb.current.onError(errorMessage(err))
      setStatus('idle')
    } finally {
      starting.current = false
    }
  }, [stopSpeaking, engine])

  const stop = useCallback(async () => {
    const rec = recording.current
    if (!rec) return
    recording.current = null
    setStatus('transcribing')
    try {
      const audio = await rec.stop()
      const text = await transcribe(audio, engine)
      setStatus('idle')
      if (text) cb.current.onTranscript(text)
      else cb.current.onError("I didn't catch that. Hold the mic (or Space) while you talk.")
    } catch (err) {
      setStatus('idle')
      cb.current.onError(errorMessage(err))
    }
  }, [engine])

  const toggle = useCallback(() => {
    if (recording.current) void stop()
    else void start()
  }, [start, stop])

  const say = useCallback(
    (text: string, messageId: string) => {
      stopSpeaking()
      setStatus('speaking')
      const s = speak(text, {
        engine: settings?.ttsEngine ?? 'system',
        voice: settings?.ttsVoice ?? '',
        rate: settings?.ttsRate ?? 1,
        onChunk: (chunk) => setCaption({ text: chunk.speak, messageId }),
        onDirective: (d) => cb.current.onDirective(d),
        onEnd: () => {
          if (speech.current === s) {
            speech.current = null
            setCaption(null)
            setStatus('idle')
          }
        }
      })
      speech.current = s
      s.done.catch((err) => cb.current.onError(errorMessage(err)))
    },
    [settings?.ttsEngine, settings?.ttsVoice, settings?.ttsRate, stopSpeaking]
  )

  // Hold Space to talk, unless typing or a button has focus.
  useEffect(() => {
    const typing = (el: Element | null) =>
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement || (el instanceof HTMLElement && el.isContentEditable)
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(document.activeElement)) return
      e.preventDefault()
      void start()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !recording.current) return
      e.preventDefault()
      void stop()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [start, stop])

  useEffect(
    () => () => {
      recording.current?.cancel()
      speech.current?.cancel()
    },
    []
  )

  return { status, caption, modelPct, toggle, say, stopSpeaking }
}
