import skill from './teach/SKILL.md?raw'

/**
 * The tutor's method: the mint edition of the learner's /teach skill
 * (./teach/SKILL.md). Every job gets the Core section plus only the sections it
 * needs, so prompts stay small while the whole method stays in one editable file.
 */
export const TEACH_SECTIONS = {
  core: 'Core',
  intake: 'Intake and mission',
  sources: 'Sources and resources',
  curriculum: 'Curriculum',
  lessons: 'Lessons',
  practice: 'Practice and feedback',
  diagnostics: 'Diagnostics and mastery',
  help: 'Explaining and the help ladder',
  wisdom: 'Wisdom',
  records: 'Learning records',
  glossary: 'Glossary',
  reference: 'Reference sheets and notes',
  diagrams: 'Diagrams'
} as const

export type TeachSection = Exclude<keyof typeof TEACH_SECTIONS, 'core'>

/** Split a markdown document into its "## " sections (frontmatter and preamble dropped). */
export function parseSections(markdown: string): Map<string, string> {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '')
  const sections = new Map<string, string>()
  let heading: string | null = null
  let lines: string[] = []
  const flush = () => {
    if (heading !== null) sections.set(heading, lines.join('\n').trim())
  }
  for (const line of body.split('\n')) {
    const m = /^## (.+?)\s*$/.exec(line)
    if (m) {
      flush()
      heading = m[1]
      lines = []
    } else if (heading !== null) {
      lines.push(line)
    }
  }
  flush()
  return sections
}

function load(markdown: string): Record<keyof typeof TEACH_SECTIONS, string> {
  const parsed = parseSections(markdown)
  const out = {} as Record<keyof typeof TEACH_SECTIONS, string>
  for (const [key, heading] of Object.entries(TEACH_SECTIONS) as [keyof typeof TEACH_SECTIONS, string][]) {
    const text = parsed.get(heading)
    // A renamed heading would silently drop part of the method from every prompt.
    if (!text) throw new Error(`teach skill is missing the "## ${heading}" section`)
    out[key] = text
  }
  return out
}

const SECTIONS = load(skill)

/** The tutor's standing instructions: Core plus the named sections of the teach skill. */
export function teach(...sections: TeachSection[]): string {
  const parts = [SECTIONS.core, ...[...new Set(sections)].map((s) => `## ${TEACH_SECTIONS[s]}\n\n${SECTIONS[s]}`)]
  return `${parts.join('\n\n')}`
}
