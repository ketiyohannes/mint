import { describe, expect, it } from 'vitest'
import { AgentError } from '../../src/main/agents/types'
import type { Kernel } from '../../src/main/services/kernel'
import { ThreadService } from '../../src/main/services/threads'

describe('stopping chat work', () => {
  it('settles at once when stopped and hands the work an aborted signal', async () => {
    const threads = new ThreadService({} as Kernel)
    let seen: AbortSignal | undefined
    // Work that would never finish on its own (like a model turn that ignores the stop for a while).
    const running = threads.track('s1', (signal) => {
      seen = signal
      return new Promise<string>(() => undefined)
    })
    threads.cancel('s1')
    await expect(running).rejects.toSatisfy((e: unknown) => e instanceof AgentError && e.kind === 'aborted')
    expect(seen?.aborted).toBe(true)
  })

  it('returns the result when not stopped, and forgets the stream afterwards', async () => {
    const threads = new ThreadService({} as Kernel)
    await expect(threads.track('s2', async () => 'done')).resolves.toBe('done')
    expect(() => threads.cancel('s2')).not.toThrow() // nothing left to stop
  })
})
