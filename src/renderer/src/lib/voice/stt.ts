import { api } from '../api'
import { encodeWav, isSilent } from './audio'

/** Speech-to-text router: local Whisper by default, OpenAI when chosen in Settings. */

let worker: Worker | null = null
let ready: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()
const progressListeners = new Set<(pct: number) => void>()

export function onModelProgress(cb: (pct: number) => void): () => void {
  progressListeners.add(cb)
  return () => progressListeners.delete(cb)
}

function ensureWorker(): Promise<void> {
  if (ready) return ready
  worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
  ready = new Promise<void>((resolve, reject) => {
    worker!.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; id?: number; text?: string; error?: string; progress?: number }
      if (m.type === 'ready') resolve()
      else if (m.type === 'error') {
        ready = null
        worker?.terminate()
        worker = null
        reject(new Error(`Local speech model failed to load: ${m.error}`))
      } else if (m.type === 'progress' && typeof m.progress === 'number') progressListeners.forEach((cb) => cb(m.progress!))
      else if (m.type === 'result' && m.id) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (!p) return
        if (m.error) p.reject(new Error(m.error))
        else p.resolve(m.text ?? '')
      }
    }
    worker!.onerror = (e) => {
      ready = null
      reject(new Error(e.message || 'Speech worker crashed.'))
    }
  })
  worker.postMessage({ type: 'init', ortBase: new URL('ort/', document.baseURI).href })
  return ready
}

/** Warm the local model in the background (first use downloads ~80 MB). */
export function preloadLocalWhisper(): void {
  void ensureWorker().catch(() => undefined)
}

export async function transcribe(samples: Float32Array, engine: 'local-whisper' | 'openai'): Promise<string> {
  if (isSilent(samples)) return ''
  if (engine === 'openai') return api.voice.transcribe(encodeWav(samples))
  await ensureWorker()
  const id = nextId++
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ type: 'transcribe', id, audio: samples }, [samples.buffer])
  })
}
