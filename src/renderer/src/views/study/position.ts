/**
 * Where the learner was in each source, so coming back to it (from another
 * source, the other view, or tomorrow) opens there instead of at the top.
 */
const KEY = 'mint.readingPositions'
const MAX = 200

/** Text view: the block at the top of the view and how far its top sits below it. Page view: a page and how far down it. */
export type ReadingPosition = { block: string; offset: number } | { page: number; frac: number }

let positions: Map<string, ReadingPosition> | null = null
let writing: ReturnType<typeof setTimeout> | undefined

function all(): Map<string, ReadingPosition> {
  if (positions) return positions
  positions = new Map()
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (Array.isArray(stored)) for (const entry of stored as [string, ReadingPosition][]) if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1]) positions.set(entry[0], entry[1])
  } catch {
    // Unreadable: start without any.
  }
  return positions
}

export function positionKey(classId: string, sourceId: string, view: 'text' | 'pdf'): string {
  return `${classId}/${sourceId}/${view}`
}

export function readingPosition(key: string): ReadingPosition | undefined {
  return all().get(key)
}

export function rememberPosition(key: string, position: ReadingPosition): void {
  const map = all()
  // Re-inserted, so the least recently read sources are the ones dropped.
  map.delete(key)
  map.set(key, position)
  while (map.size > MAX) map.delete(map.keys().next().value!)
  clearTimeout(writing)
  writing = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify([...map]))
    } catch {
      // Storage full or unavailable: the places last as long as the window.
    }
  }, 500)
}

/** A deleted class takes its places with it. */
export function forgetPositions(classId: string): void {
  const map = all()
  for (const key of [...map.keys()]) if (key.startsWith(`${classId}/`)) map.delete(key)
  try {
    localStorage.setItem(KEY, JSON.stringify([...map]))
  } catch {
    // Nothing to clean up.
  }
}

/**
 * A jump to a cited passage is made once, by the viewer that was opened for
 * it. The host keeps handing the same request to whatever it shows next
 * (another source, the other view), which must not jump again.
 */
let taken = 0

export function isFreshJump(nonce: number): boolean {
  return taken !== nonce
}

/** Whether this viewer (`mine` is its own record) is the one to make the jump. */
export function takeJump(nonce: number, mine: { current: number }): boolean {
  if (taken === nonce && mine.current !== nonce) return false
  taken = nonce
  mine.current = nonce
  return true
}
