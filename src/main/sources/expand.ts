import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export const READABLE_EXTENSIONS = ['pdf', 'md', 'markdown', 'txt', 'html', 'htm', 'docx']
const MAX_DEPTH = 4
const MAX_FILES = 60
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build', 'out'])

const readable = (path: string) => READABLE_EXTENSIONS.includes(extname(path).toLowerCase().slice(1))
const hidden = (path: string) => basename(path).startsWith('.')

/**
 * Turns picked paths (files and folders) into a list of readable files.
 * Folders are walked like a project: hidden entries and build folders are
 * skipped, files are sorted naturally, and the walk is bounded in depth and size.
 * Files picked explicitly are always kept, so unsupported ones still report an error.
 */
export async function expandPaths(paths: string[]): Promise<{ files: string[]; truncated: boolean }> {
  const out: string[] = []
  let truncated = false
  const seen = new Set<string>()
  const push = (p: string) => {
    if (seen.has(p)) return
    if (out.length >= MAX_FILES) {
      truncated = true
      return
    }
    seen.add(p)
    out.push(p)
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    for (const e of entries) {
      const full = join(dir, e.name)
      if (hidden(full)) continue
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1)
      } else if (e.isFile() && readable(full)) push(full)
    }
  }

  for (const p of paths) {
    let info
    try {
      info = await stat(p)
    } catch {
      push(p) // Let the importer report the missing file.
      continue
    }
    if (info.isDirectory()) await walk(p, 0)
    else push(p)
  }
  return { files: out, truncated }
}

/** A friendly class name from the first picked path: a folder name, or a file name without its extension. */
export async function titleFromPaths(paths: string[]): Promise<string> {
  const first = paths[0]
  if (!first) return ''
  try {
    if ((await stat(first)).isDirectory()) return basename(first)
  } catch {
    // Fall through to the file name.
  }
  return basename(first).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
}
