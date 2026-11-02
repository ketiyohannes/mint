#!/usr/bin/env node
/**
 * Prepares the third-party libraries used by the diagram sandbox
 * (resources/diagram-sandbox/vendor/, git-ignored):
 *
 *   vendor/p5.min.js      copied verbatim from node_modules/p5
 *   vendor/three.iife.js  three + OrbitControls bundled as an IIFE that sets globalThis.THREE
 *
 * The sandbox page loads these as classic scripts from its own origin, so it
 * never needs the network. The script is idempotent: outputs are rebuilt only
 * when the installed library versions or this script change.
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = join(root, 'resources', 'diagram-sandbox', 'vendor')
const p5Source = join(root, 'node_modules', 'p5', 'lib', 'p5.min.js')
const p5Target = join(vendorDir, 'p5.min.js')
const threeTarget = join(vendorDir, 'three.iife.js')
const stampFile = join(vendorDir, '.stamp.json')

const THREE_ENTRY = [
  "import * as THREE from 'three'",
  "import { OrbitControls } from 'three/addons/controls/OrbitControls.js'",
  'globalThis.THREE = { ...THREE, OrbitControls }'
].join('\n')

async function packageVersion(name) {
  const pkg = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'))
  return pkg.version
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function computeStamp() {
  const self = await readFile(fileURLToPath(import.meta.url))
  return JSON.stringify({
    p5: await packageVersion('p5'),
    three: await packageVersion('three'),
    esbuild: await packageVersion('esbuild'),
    script: createHash('sha256').update(self).digest('hex').slice(0, 16)
  })
}

async function main() {
  const started = performance.now()
  const stamp = await computeStamp()
  const upToDate =
    (await exists(p5Target)) &&
    (await exists(threeTarget)) &&
    (await readFile(stampFile, 'utf8').catch(() => '')) === stamp

  if (upToDate) {
    console.log(`[diagram-runtime] vendor up to date (${relative(root, vendorDir)})`)
    return
  }

  await mkdir(vendorDir, { recursive: true })
  // Resolve esbuild from the repo so the script works from any cwd.
  const esbuild = createRequire(join(root, 'package.json'))('esbuild')

  await Promise.all([
    copyFile(p5Source, p5Target),
    esbuild.build({
      stdin: { contents: THREE_ENTRY, resolveDir: root, sourcefile: 'three-entry.js', loader: 'js' },
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      legalComments: 'none',
      logLevel: 'warning',
      outfile: threeTarget
    })
  ])
  await writeFile(stampFile, stamp)

  const ms = Math.round(performance.now() - started)
  console.log(`[diagram-runtime] built p5.min.js + three.iife.js into ${relative(root, vendorDir)} in ${ms}ms`)
}

main().catch((err) => {
  console.error('[diagram-runtime] failed:', err)
  process.exit(1)
})
