#!/usr/bin/env node
/**
 * Starts mint from source: `npm run dev` (hot reload) and `npm start` (the
 * production build, unpackaged). It makes both work from any terminal: inside
 * VS Code or another Electron app, ELECTRON_RUN_AS_NODE is set and would start
 * Electron as plain Node.
 *
 *   npm run dev                hot reload; restarts when main or preload code changes
 *   npm run dev -- --fresh     a new, empty profile for this run (the first-run experience)
 *   npm run dev -- --real      the installed app's profile and data (quit mint first)
 *   npm run dev -- --inspect   lets a debugger attach to the main process (port 5858)
 *
 * Without --real, a copy run from source keeps its own profile ("mint-dev"), so
 * it never shares data or the single-instance lock with an installed mint.
 * Other arguments are passed to electron-vite.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [command = 'dev', ...rest] = process.argv.slice(2)
const fresh = rest.includes('--fresh')
const real = rest.includes('--real')
const args = rest.filter((a) => a !== '--fresh' && a !== '--real')

if (fresh && real) {
  console.error('[dev] --fresh and --real cannot be combined.')
  process.exit(1)
}

const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
let profile = null
if (fresh) {
  profile = mkdtempSync(join(tmpdir(), 'mint-fresh-'))
  env.MINT_USER_DATA = profile
  console.log(`[dev] fresh profile: ${profile} (removed when mint quits)`)
}
if (real) env.MINT_DEV_PROFILE = '0'

// Its own process group, so stopping this script stops electron-vite and the app it started, not just one of them.
const grouped = process.platform !== 'win32'
const child = spawn(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), command, ...(command === 'dev' ? ['--watch'] : []), ...args], {
  cwd: root,
  env,
  stdio: 'inherit',
  detached: grouped
})

function stop(signal) {
  try {
    if (grouped) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already gone.
  }
}

let done = false
function finish(code) {
  if (done) return
  done = true
  if (profile) rmSync(profile, { recursive: true, force: true })
  process.exit(code)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stop(signal)
    // An app that will not quit is not allowed to keep the terminal.
    setTimeout(() => {
      stop('SIGKILL')
      finish(1)
    }, 5000).unref()
  })
}
child.on('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)))
child.on('error', (err) => {
  console.error(`[dev] could not start electron-vite: ${err.message}`)
  finish(1)
})
