import { z } from 'zod'

/**
 * Output schemas for every structured job. All fields are required (use
 * nullable instead of optional) so the same schema works as a strict JSON
 * schema for both Claude and Codex structured output.
 */

export const SourceProposalsSchema = z.object({
  proposals: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      kind: z.enum(['web', 'youtube']),
      why: z.string(),
      covers: z.string()
    })
  )
})

export const DiagnosticQuestionsSchema = z.object({ questions: z.array(z.string()) })

const RecordProposalSchema = z.object({
  title: z.string(),
  body: z.string(),
  evidence: z.string(),
  kind: z.enum(['understanding', 'prior-knowledge', 'misconception', 'mission-shift'])
})

export const DiagnosticResultSchema = z.object({
  summary: z.string(),
  startingLevel: z.string(),
  records: z.array(RecordProposalSchema)
})

export const CurriculumSchema = z.object({
  summary: z.string(),
  project: z.object({ title: z.string(), deliverable: z.string() }).nullable(),
  assumptions: z.array(z.string()),
  cadence: z.string(),
  milestones: z.array(
    z.object({
      title: z.string(),
      deliverable: z.string(),
      topics: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          objective: z.string(),
          prerequisites: z.array(z.string()),
          sources: z.array(z.object({ sourceId: z.string(), section: z.string(), note: z.string() })),
          practice: z.string(),
          gate: z.string()
        })
      )
    })
  )
})

export const BriefSchema = z.object({
  win: z.string(),
  whyItMatters: z.string(),
  readings: z.array(z.object({ sourceId: z.string(), section: z.string(), note: z.string() })),
  questions: z.array(z.string())
})

export const CheckPromptSchema = z.object({ prompt: z.string() })

export const VerdictSchema = z.object({
  result: z.enum(['pass', 'partial', 'fail']),
  feedback: z.string(),
  misconceptions: z.array(z.string())
})

export const WrapSchema = z.object({
  summary: z.string(),
  records: z.array(RecordProposalSchema),
  terms: z.array(z.object({ term: z.string(), definition: z.string(), avoid: z.array(z.string()), evidence: z.string() }))
})

export const GlossaryCheckSchema = z.object({
  accepted: z.boolean(),
  feedback: z.string(),
  definition: z.string(),
  avoid: z.array(z.string())
})

export const DiagramSchema = z.object({
  engine: z.enum(['p5', 'three']),
  title: z.string(),
  code: z.string(),
  elements: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
  params: z.array(z.object({ id: z.string(), label: z.string(), min: z.number(), max: z.number(), step: z.number(), value: z.number() })),
  caption: z.string()
})

export const ReferenceDraftSchema = z.object({ title: z.string(), body: z.string() })

export const IntakeQuestionsSchema = z.object({
  title: z.string(),
  intro: z.string(),
  questions: z.array(
    z.object({
      header: z.string(),
      question: z.string(),
      multiSelect: z.boolean(),
      options: z.array(z.object({ label: z.string(), description: z.string() }))
    })
  )
})

export const QuizSchema = z.object({
  title: z.string(),
  questions: z.array(z.object({ prompt: z.string(), options: z.array(z.string()), answer: z.number().int(), explanation: z.string() }))
})

export const ExerciseSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  language: z.enum(['javascript', 'python']),
  starter: z.string(),
  tests: z.string(),
  hint: z.string()
})

export type CurriculumOutput = z.infer<typeof CurriculumSchema>
export type DiagramOutput = z.infer<typeof DiagramSchema>
export type IntakeQuestionsOutput = z.infer<typeof IntakeQuestionsSchema>
export type QuizOutput = z.infer<typeof QuizSchema>
export type ExerciseOutput = z.infer<typeof ExerciseSchema>
