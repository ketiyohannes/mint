/// <reference lib="webworker" />
// Local speech-to-text: Whisper (base.en, 8-bit) running in WebAssembly.
// The model downloads once from Hugging Face; audio never leaves the machine.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

type In = { type: 'init'; ortBase: string } | { type: 'transcribe'; id: number; audio: Float32Array }

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null

function load(ortBase: string): Promise<AutomaticSpeechRecognitionPipeline> {
  env.allowLocalModels = false
  env.useBrowserCache = typeof caches !== 'undefined'
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } }
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = ortBase
    onnx.wasm.numThreads = 1
  }
  ;(env as { useWasmCache?: boolean }).useWasmCache = false
  return pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
      if (p.status === 'progress' && typeof p.progress === 'number') postMessage({ type: 'progress', progress: p.progress, file: p.file })
    }
  }) as Promise<AutomaticSpeechRecognitionPipeline>
}

self.onmessage = async (e: MessageEvent<In>) => {
  const msg = e.data
  if (msg.type === 'init') {
    if (!asr) asr = load(msg.ortBase)
    try {
      await asr
      postMessage({ type: 'ready' })
    } catch (err) {
      asr = null
      postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (msg.type === 'transcribe') {
    try {
      if (!asr) throw new Error('Speech model not loaded')
      const run = await asr
      const out = (await run(msg.audio, { chunk_length_s: 30, stride_length_s: 5 })) as { text?: string } | { text?: string }[]
      const text = Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : (out.text ?? '')
      postMessage({ type: 'result', id: msg.id, text: text.trim() })
    } catch (err) {
      postMessage({ type: 'result', id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
