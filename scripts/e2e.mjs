#!/usr/bin/env node
/**
 * Runs the end-to-end test: `npm run test:e2e`.
 *
 *   npm run test:e2e                  build, then drive the whole app
 *   npm run test:e2e -- --no-build    reuse the last build in out/
 *   npm run test:e2e -- --show        show the window while the test drives it
 *   npm run test:e2e -- --shots       save a screenshot of each screen into .shots/
 *   npm run test:e2e -- --app <path>  drive a packaged app instead of the build
 *
 * Other arguments are passed to Playwright (for example --debug, or -g "pattern").
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

/** Removes `flag` from the arguments; with `takesValue`, also the argument after it. */
function take(flag, takesValue = false) {
  const i = args.indexOf(flag)
  if (i < 0) return null
  const [, value] = args.splice(i, takesValue ? 2 : 1)
  if (takesValue && !value) {
    console.error(`[e2e] ${flag} needs a value.`)
    process.exit(1)
  }
  return takesValue ? value : true
}

const noBuild = take('--no-build')
const show = take('--show')
const shots = take('--shots')
const packaged = take('--app', true)

// The test launches Electron itself; see scripts/dev.mjs for why this variable must go.
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
if (show) env.MINT_E2E_SHOW = '1'
if (packaged) env.MINT_E2E_EXECUTABLE = resolve(packaged)
if (shots) {
  const dir = join(root, '.shots')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir)
  env.MINT_SHOTS = dir
}

function run(command, commandArgs, options = {}) {
  const res = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit', ...options })
  if (res.error) {
    console.error(`[e2e] could not run ${command}: ${res.error.message}`)
    process.exit(1)
  }
  if (res.status !== 0) process.exit(res.status ?? 1)
}

// A packaged app carries its own build.
if (!noBuild && !packaged) run('npm', ['run', 'build'], { shell: process.platform === 'win32' })
run(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...args])
if (shots) console.log(`[e2e] screenshots: ${join(root, '.shots')}`)
