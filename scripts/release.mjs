#!/usr/bin/env node
/**
 * Cuts a release: `npm run release`. It writes the new version everywhere it
 * appears, checks the code, commits, pushes main and creates the GitHub release
 * whose tag starts the builds (.github/workflows/release.yml). Installed copies
 * of mint update themselves from that release once the builds finish.
 *
 *   npm run release                      the next pre-release (0.1.0-alpha.12 -> 0.1.0-alpha.13)
 *   npm run release -- 0.2.0             an explicit version
 *   npm run release -- --notes "…"       release notes (default: generated from the commits)
 *   npm run release -- --dry-run         print the plan and change nothing
 *   npm run release -- --bump-only       only write the version; no commit, push or release
 *   npm run release -- --no-check        skip the typecheck and unit tests
 *   npm run release -- --gh-user <name>  push and release as this GitHub CLI account
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

function fail(message) {
  console.error(`[release] ${message}`)
  process.exit(1)
}

/** Removes `flag` from the arguments; with `takesValue`, also the argument after it. */
function take(flag, takesValue = false) {
  const i = args.indexOf(flag)
  if (i < 0) return null
  const [, value] = args.splice(i, takesValue ? 2 : 1)
  if (takesValue && !value) fail(`${flag} needs a value.`)
  return takesValue ? value : true
}

const dryRun = take('--dry-run')
const bumpOnly = take('--bump-only')
const noCheck = take('--no-check')
const notes = take('--notes', true)
const ghUser = take('--gh-user', true)
if (args.length > 1 || args[0]?.startsWith('-')) fail(`Unexpected arguments: ${args.join(' ')}`)

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 0.1.0-alpha.12 -> 0.1.0-alpha.13; 0.1.0-beta -> 0.1.0-beta.1; 1.2.3 -> 1.2.4. */
function nextVersion(version) {
  const [core, pre] = version.split(/-(.*)/s)
  if (!pre) {
    const [major, minor, patch] = core.split('.').map(Number)
    return `${major}.${minor}.${patch + 1}`
  }
  const parts = pre.split('.')
  const last = parts.length - 1
  if (/^\d+$/.test(parts[last])) parts[last] = String(Number(parts[last]) + 1)
  else parts.push('1')
  return `${core}-${parts.join('.')}`
}

const read = (file) => readFileSync(join(root, file), 'utf8')
const current = JSON.parse(read('package.json')).version
const version = (args[0] ?? nextVersion(current)).replace(/^v/, '')
if (!SEMVER.test(version)) fail(`"${version}" is not a version like 0.1.0-alpha.13.`)
if (version === current) fail(`The version is already ${current}.`)
const tag = `v${version}`

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim()
}

function run(command, commandArgs, options = {}) {
  console.log(`[release] ${command} ${commandArgs.join(' ')}`)
  if (dryRun) return
  const res = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', ...options })
  if (res.error) fail(`Could not run ${command}: ${res.error.message}`)
  if (res.status !== 0) fail(`${command} ${commandArgs[0]} failed.`)
}

/** Replaces exactly `count` occurrences of `from`, so a changed file layout fails loudly. */
function rewrite(file, from, to, count) {
  const text = read(file)
  const found = text.split(from).length - 1
  if (found < count) fail(`Expected ${count} occurrence(s) of ${from} in ${file}, found ${found}.`)
  let left = count
  const next = text.replaceAll(from, (match) => (left-- > 0 ? to : match))
  console.log(`[release] ${file}: ${current} -> ${version}`)
  if (!dryRun) writeFileSync(join(root, file), next)
}

/** A dry run reports what would stop the release and carries on. */
function ensure(ok, message) {
  if (ok) return
  if (!dryRun) fail(message)
  console.warn(`[release] would stop here: ${message}`)
}

if (!bumpOnly) {
  ensure(git('rev-parse', '--abbrev-ref', 'HEAD') === 'main', 'Releases are cut from main.')
  ensure(!git('status', '--porcelain'), 'Commit or stash your changes first: the release commit holds only the version.')
  ensure(!git('tag', '--list', tag), `The tag ${tag} already exists.`)
}

// The lockfile names the version twice: for the file and for the root package.
rewrite('package.json', `"version": "${current}"`, `"version": "${version}"`, 1)
rewrite('package-lock.json', `"version": "${current}"`, `"version": "${version}"`, 2)
rewrite('.github/workflows/release.yml', `v${current}`, tag, 3)

if (bumpOnly) process.exit(0)

const npm = { shell: process.platform === 'win32' }
if (!noCheck) run('npm', ['run', 'check'], npm)

// With several GitHub CLI accounts logged in, act as the named one without switching the active account.
const env = { ...process.env }
const asUser = []
if (ghUser) {
  const res = spawnSync('gh', ['auth', 'token', '--user', ghUser], { encoding: 'utf8' })
  if (res.status !== 0) fail(`The GitHub CLI has no account named ${ghUser}.`)
  env.GH_TOKEN = res.stdout.trim()
  asUser.push('-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f')
}

run('git', ['add', 'package.json', 'package-lock.json', '.github/workflows/release.yml'])
run('git', ['commit', '-m', `Release ${tag}`])
run('git', [...asUser, 'push', 'origin', 'main'], { env })
run('gh', ['release', 'create', tag, '--target', 'main', '--title', tag, ...(version.includes('-') ? ['--prerelease'] : []), ...(notes ? ['--notes', notes] : ['--generate-notes'])], { env })

console.log(dryRun ? '[release] dry run: nothing was changed.' : `[release] ${tag} is out. The builds take about ten minutes: gh run watch`)
