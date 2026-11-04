// Copies the Pyodide runtime (CPython compiled to WebAssembly) into the code
// sandbox, so Python exercises run offline and never load code from a CDN.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules/pyodide')
const dest = join(root, 'resources/diagram-sandbox/pyodide')
const files = ['pyodide.js', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']

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
console.log(`[prepare-pyodide] ${copied ? `copied ${copied} file(s)` : 'up to date'} -> resources/diagram-sandbox/pyodide`)
