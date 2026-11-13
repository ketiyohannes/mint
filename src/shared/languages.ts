/**
 * The languages a learner can write code in when answering a lesson's check,
 * and the tutor can ask for. `plain` is code with no highlighting: pseudocode,
 * or a language that is not in the list.
 */
export const CODE_LANGUAGES = [
  { id: 'python', label: 'Python', aliases: ['py', 'python3'] },
  { id: 'javascript', label: 'JavaScript', aliases: ['js', 'jsx', 'node', 'mjs'] },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts', 'tsx'] },
  { id: 'c', label: 'C', aliases: ['h'] },
  { id: 'cpp', label: 'C++', aliases: ['c++', 'cc', 'cxx', 'hpp'] },
  { id: 'rust', label: 'Rust', aliases: ['rs'] },
  { id: 'zig', label: 'Zig', aliases: [] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'java', label: 'Java', aliases: [] },
  { id: 'csharp', label: 'C#', aliases: ['c#', 'cs', 'dotnet'] },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt'] },
  { id: 'swift', label: 'Swift', aliases: [] },
  { id: 'ruby', label: 'Ruby', aliases: ['rb'] },
  { id: 'sql', label: 'SQL', aliases: ['postgres', 'postgresql', 'mysql', 'sqlite'] },
  { id: 'shell', label: 'Shell', aliases: ['sh', 'bash', 'zsh'] },
  { id: 'haskell', label: 'Haskell', aliases: ['hs'] },
  { id: 'lua', label: 'Lua', aliases: [] },
  { id: 'r', label: 'R', aliases: [] },
  { id: 'plain', label: 'Plain text', aliases: ['text', 'txt', 'pseudocode', 'pseudo', 'none'] }
] as const

export type LanguageId = (typeof CODE_LANGUAGES)[number]['id']

export const LANGUAGE_IDS: readonly LanguageId[] = CODE_LANGUAGES.map((l) => l.id)

const BY_NAME = new Map<string, LanguageId>()
for (const l of CODE_LANGUAGES) for (const name of [l.id, l.label, ...l.aliases]) BY_NAME.set(name.toLowerCase(), l.id)

/** The language a name means ("py", "C++", "TSX"), or null when it is not one of ours. */
export function languageFromName(name: unknown): LanguageId | null {
  return typeof name === 'string' ? (BY_NAME.get(name.trim().toLowerCase()) ?? null) : null
}

export function languageLabel(id: LanguageId): string {
  return CODE_LANGUAGES.find((l) => l.id === id)?.label ?? id
}
