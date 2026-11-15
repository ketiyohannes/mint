import { QUICK_MAX_MINUTES, QUICK_MIN_MINUTES } from '@shared/mode'
import type { QuickCourse, QuickSection } from '@shared/types'

/** The plan as the model wrote it (already schema-validated). */
export interface RawQuickPlan {
  title: string
  summary: string
  minutes: number
  sections: { title: string; covers: string; minutes: number }[]
}

const MAX_SECTIONS = 14
/** One part is one model turn: longer than this and the turn gets unreliable. */
const MAX_SECTION_MINUTES = 25
/** A part's text, at most (far beyond what its reading time needs). */
const MAX_BODY = 80_000

const oneLine = (s: string, max: number) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** The reading time a learner asked for, as a whole number of minutes in range; null when they left it open. */
export function cleanMinutes(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(clamp(n, QUICK_MIN_MINUTES, QUICK_MAX_MINUTES)) : null
}

/**
 * Turn a model-written plan into a course to write. Code guarantees:
 *  - a title, and at least one part with a title
 *  - a bounded number of parts, each short enough to write in one turn
 *  - the course's reading time is the sum of its parts, and close to what the
 *    learner asked for when they named a length
 */
export function validateQuickPlan(raw: RawQuickPlan, request: string, asked: number | null): QuickCourse | null {
  const parts = raw.sections
    .map((s) => ({ title: oneLine(s.title, 120), covers: oneLine(s.covers, 800), minutes: Number.isFinite(s.minutes) && s.minutes > 0 ? s.minutes : 5 }))
    .filter((s) => s.title)
    .slice(0, MAX_SECTIONS)
  if (!parts.length) return null

  // The whole is what was asked for, else what the model chose, else what its parts add up to.
  const planned = parts.reduce((sum, s) => sum + s.minutes, 0)
  const total = clamp(asked ?? (Number.isFinite(raw.minutes) && raw.minutes > 0 ? raw.minutes : planned), QUICK_MIN_MINUTES, Math.min(QUICK_MAX_MINUTES, parts.length * MAX_SECTION_MINUTES))
  const scale = total / planned
  const sections: QuickSection[] = parts.map((s, i) => ({ id: `p${i + 1}`, title: s.title, covers: s.covers, minutes: Math.round(clamp(s.minutes * scale, 1, MAX_SECTION_MINUTES)) }))
  // Rounding each part can leave the whole a minute or two off: the longest part takes the difference.
  const longest = sections.reduce((a, b) => (b.minutes > a.minutes ? b : a))
  longest.minutes = clamp(longest.minutes + Math.round(total) - sections.reduce((sum, s) => sum + s.minutes, 0), 1, MAX_SECTION_MINUTES)

  const now = new Date().toISOString()
  return {
    title: oneLine(raw.title, 100) || oneLine(request, 60) || 'Quick course',
    summary: oneLine(raw.summary, 500),
    request: request.trim().slice(0, 4000),
    minutes: sections.reduce((sum, s) => sum + s.minutes, 0),
    sections,
    status: 'writing',
    createdAt: now,
    updatedAt: now
  }
}

/**
 * A written part as it is stored: mint shows the part's title itself, so a
 * heading the model opened with is dropped, and the text is bounded.
 */
export function cleanSectionBody(text: string): string {
  return text
    .trim()
    .replace(/^#{1,6} [^\n]*\n+/, '')
    .slice(0, MAX_BODY)
    .trim()
}
