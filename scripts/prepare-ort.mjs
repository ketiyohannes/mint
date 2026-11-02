// Copies the ONNX Runtime WebAssembly files used by local Whisper into the
// renderer's public folder, so speech recognition never loads code from a CDN.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules/onnxruntime-web/dist')
const dest = join(root, 'src/renderer/public/ort')
const files = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']

mkdirSync(dest, { recursive: true })
let copied = 0
for (const f of files) {
  const from = join(src, f)
  const to = join(dest, f)
  if (!existsSync(from)) throw new Error(`Missing ${from}. Run npm install.`)
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue
  copyFileSync(from, to)
  copied++
}
console.log(`[prepare-ort] ${copied ? `copied ${copied} file(s)` : 'up to date'} -> src/renderer/public/ort`)
