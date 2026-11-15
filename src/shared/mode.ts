import { CLASS_MODES, type ClassMode } from './types'

/** A class's mode. One made before modes existed is a course. */
export function classMode(meta: { mode?: ClassMode }): ClassMode {
  return CLASS_MODES.includes(meta.mode as ClassMode) ? (meta.mode as ClassMode) : 'course'
}

export const MODE_LABEL: Record<ClassMode, string> = { course: 'Course', simple: 'Simple', quick: 'Quick course' }

/** What each mode does, for the menus that offer it. */
export const MODE_HINT: Record<ClassMode, string> = {
  course: 'A plan of lessons with checks, built on your materials.',
  simple: 'Open a paper or a book. mint lists what is in it and explains what you pick.',
  quick: 'Describe what you want to learn. mint writes a short course to read.'
}

/** The reading times a quick course can be asked for, in minutes. */
export const QUICK_LENGTHS: readonly { minutes: number; label: string }[] = [
  { minutes: 5, label: '5 min' },
  { minutes: 20, label: '20 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' }
]

export const QUICK_MIN_MINUTES = 3
export const QUICK_MAX_MINUTES = 240

/** "25 min", "1 h", "1 h 30 min". */
export function readingTime(minutes: number): string {
  const m = Math.max(1, Math.round(minutes))
  if (m < 60) return `${m} min`
  const rest = m % 60
  return rest ? `${Math.floor(m / 60)} h ${rest} min` : `${Math.floor(m / 60)} h`
}

/** The stream a part of a quick course is written on: the panel follows it while the part is not stored yet. */
export function quickStreamId(classId: string, sectionId: string): string {
  return `quick:${classId}:${sectionId}`
}

/** The part a quick-course stream belongs to, or null for any other stream. */
export function quickStreamSection(classId: string, streamId: string): string | null {
  const prefix = `quick:${classId}:`
  return streamId.startsWith(prefix) ? streamId.slice(prefix.length) : null
}

/** What the chat of a contents item opens with, on the learner's behalf (simple mode). */
export function explainRequest(title: string): string {
  return `Explain: ${title}`
}
