import { AgentError, type AgentRuntime, type AgentTurnRequest, type AgentTurnResult, type ProviderCheck } from './types'

/**
 * Offline, scripted runtime. Every job supplies a deterministic `demo`
 * answer computed from the real inputs (your sources, curriculum, answers),
 * so the whole app can be explored and tested without model access. It is
 * clearly labeled "Demo" in Settings and never pretends to be a model.
 */
export class DemoRuntime implements AgentRuntime {
  readonly id = 'demo' as const

  constructor(private readonly delayMs = 8) {}

  async run(req: AgentTurnRequest): Promise<AgentTurnResult> {
    if (req.signal?.aborted) throw new AgentError('Cancelled', 'aborted')
    const answer = req.demo ? await req.demo() : { text: 'Demo mode has no scripted answer for this request.' }
    const structured = answer.structured
    const text = answer.text ?? (structured === undefined ? '' : JSON.stringify(structured))
    if (req.onDelta && text) {
      // Stream in small word groups so the UI exercises its streaming path.
      const parts = text.match(/\S+\s*/g) ?? [text]
      for (let i = 0; i < parts.length; i += 3) {
        if (req.signal?.aborted) throw new AgentError('Cancelled', 'aborted')
        req.onDelta(parts.slice(i, i + 3).join(''))
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
      }
    }
    return { text, structured }
  }

  async check(): Promise<ProviderCheck> {
    return { ok: true, message: 'Demo mode is offline and scripted. Answers are not from a model.' }
  }

  async dispose(): Promise<void> {}
}
