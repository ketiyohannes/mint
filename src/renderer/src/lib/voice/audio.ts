/** Microphone capture for push-to-talk, resampled to 16 kHz mono for Whisper. */

export interface Recording {
  stop(): Promise<Float32Array>
  cancel(): void
}

export async function startRecording(): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This system does not expose a microphone.')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  } catch {
    throw new Error('Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone.')
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  recorder.start(250)
  const release = () => stream.getTracks().forEach((t) => t.stop())

  return {
    cancel() {
      try {
        recorder.stop()
      } catch {
        /* already stopped */
      }
      release()
    },
    stop() {
      return new Promise<Float32Array>((resolve, reject) => {
        recorder.onstop = async () => {
          release()
          try {
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
            resolve(await decodeTo16kMono(await blob.arrayBuffer()))
          } catch {
            reject(new Error('Could not read the recording.'))
          }
        }
        recorder.stop()
      })
    }
  }
}

export async function decodeTo16kMono(data: ArrayBuffer): Promise<Float32Array> {
  if (!data.byteLength) return new Float32Array(0)
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(data)
    const length = Math.max(1, Math.ceil(decoded.duration * 16000))
    const offline = new OfflineAudioContext(1, length, 16000)
    const src = offline.createBufferSource()
    src.buffer = decoded
    src.connect(offline.destination)
    src.start()
    const rendered = await offline.startRendering()
    return rendered.getChannelData(0).slice()
  } finally {
    void ctx.close()
  }
}

/** 16-bit PCM WAV for cloud transcription. */
export function encodeWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const write = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)))
  write(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

/** True when the clip is basically silence (skip transcription). */
export function isSilent(samples: Float32Array): boolean {
  if (samples.length < 16000 * 0.3) return true
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length) < 0.004
}
