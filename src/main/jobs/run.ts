import { z } from 'zod'
import { AgentError, type AgentRuntime, type AgentTurnRequest } from '../agents/types'

/**
 * Convert a zod schema to a JSON schema both harnesses accept for structured
 * output: every object closed (`additionalProperties: false`) with every
 * property required (optional values are modeled as `null` unions instead).
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>
  delete json.$schema
  return strictify(json) as Record<string, unknown>
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify)
  if (!node || typeof node !== 'object') return node
  const obj: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) obj[k] = strictify(v)
  if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
    obj.additionalProperties = false
    obj.required = Object.keys(obj.properties as object)
  }
  return obj
}

export interface StructuredJob<T> extends Omit<AgentTurnRequest, 'schema' | 'demo' | 'onDelta'> {
  schema: z.ZodType<T>
  demo: () => T | Promise<T>
}

/**
 * Run a structured job: request schema-constrained output, validate it with
 * zod, and retry once with the validation errors if the model got it wrong.
 * Nothing leaves this function unvalidated.
 */
export async function runStructured<T>(runtime: AgentRuntime, job: StructuredJob<T>): Promise<T> {
  const jsonSchema = toStrictJsonSchema(job.schema)
  let prompt = job.prompt
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runtime.run({
      ...job,
      prompt,
      schema: jsonSchema,
      demo: async () => ({ structured: await job.demo() })
    })
    const parsed = job.schema.safeParse(result.structured)
    if (parsed.success) return parsed.data
    const issues = parsed.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    if (job.signal?.aborted) throw new AgentError('Cancelled', 'aborted')
    prompt = `${job.prompt}\n\nYour previous answer did not match the required JSON schema (${issues}). Return only valid JSON that matches the schema exactly.`
  }
  throw new AgentError('The tutor returned an answer mint could not use. Please try again.', 'invalid-output')
}

export interface TextJob extends Omit<AgentTurnRequest, 'schema' | 'demo'> {
  demo: () => string | Promise<string>
}

export async function runText(runtime: AgentRuntime, job: TextJob): Promise<string> {
  const result = await runtime.run({ ...job, demo: async () => ({ text: await job.demo() }) })
  const text = result.text.trim()
  if (!text) throw new AgentError('The tutor returned an empty answer. Please try again.', 'invalid-output')
  return text
}
