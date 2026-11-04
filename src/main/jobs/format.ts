import { teach, type TeachSection } from '../pedagogy/teach'

/**
 * How every piece of learner-visible text must be written. The renderer
 * (src/renderer/src/lib/markdown.ts, used through <RichText>) renders exactly
 * this everywhere: chat, side chats, lesson briefs and checks, quizzes, plans.
 */
export const FORMAT_RULES = `## Formatting (rendered by mint, the same way everywhere)
Everything you write for the learner (chat replies, briefs, questions, checks, feedback, quiz text, plan text, every JSON string field the learner will read) is rendered as:
- Markdown: emphasis, lists, short tables, and code in fenced blocks with a language.
- Math: ALWAYS LaTeX inside delimiters, $...$ inline and $$...$$ for a display formula. Never write bare LaTeX commands (\\lambda, \\frac, \\mathbf) outside delimiters. Matrices use \\begin{bmatrix} ... \\end{bmatrix}. Inside JSON strings, escape backslashes as JSON requires.
- Values as cells: to show an array or matrix of values, use a fenced block with language "array" containing JSON, e.g. \`\`\`array\\n[[1, 2], [3, 4]]\\n\`\`\`.
- Citations: only as [[cite:...]] directives.`

/** A job's standing instructions: the teach method (Core + named sections) plus the formatting contract. */
export function tutor(...sections: TeachSection[]): string {
  return `${teach(...sections)}\n\n${FORMAT_RULES}`
}
