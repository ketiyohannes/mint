import type { CodeLanguage, CodeRunResult } from '@shared/types'
import { CODE_RUNNER_URL, isRunnerMessage, type RunRequest } from '@shared/diagramProtocol'

/**
 * Runs learner code in the sandboxed runner frame (opaque origin, no network,
 * workers with timeouts). One hidden frame is shared by every code widget.
 */
let frame: HTMLIFrameElement | null = null
let ready: Promise<void> | null = null
/** Stops listening to the current frame. */
let detach: (() => void) | null = null
const pending = new Map<string, (r: CodeRunResult) => void>()
let counter = 0
/** How long the runner frame may take to load before a run gives up on it. */
const START_TIMEOUT = 15_000

function dropFrame(): void {
  detach?.()
  detach = null
  frame?.remove()
  frame = null
  ready = null
}

function ensureFrame(): Promise<void> {
  if (ready && frame?.isConnected) return ready
  dropFrame()
  const el = document.createElement('iframe')
  el.src = CODE_RUNNER_URL
  el.setAttribute('sandbox', 'allow-scripts')
  el.setAttribute('aria-hidden', 'true')
  el.tabIndex = -1
  el.title = 'Code runner'
  el.className = 'code-runner-frame'
  frame = el
  ready = new Promise<void>((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== el.contentWindow || !isRunnerMessage(e.data)) return
      if (e.data.type === 'runner-ready') resolve()
      else {
        const done = pending.get(e.data.id)
        if (done) {
          pending.delete(e.data.id)
          done({ ok: e.data.ok, output: e.data.output, tests: e.data.tests, error: e.data.error })
        }
      }
    }
    window.addEventListener('message', onMessage)
    detach = () => window.removeEventListener('message', onMessage)
  })
  document.body.appendChild(el)
  return ready
}

export async function runCode(language: CodeLanguage, code: string, tests: string, timeoutMs = 5000): Promise<CodeRunResult> {
  // A frame that never loads must not leave the run (and its spinner) waiting forever.
  let startTimer: ReturnType<typeof setTimeout> | undefined
  const loading = ensureFrame()
  const waitedFor = frame
  const started = await Promise.race([
    loading.then(() => true),
    new Promise<boolean>((resolve) => {
      startTimer = setTimeout(() => resolve(false), START_TIMEOUT)
    })
  ])
  clearTimeout(startTimer)
  const target = started ? waitedFor?.contentWindow : null
  if (!target) {
    // The next run starts a fresh frame (unless another run already has).
    if (frame === waitedFor) dropFrame()
    return { ok: false, output: [], tests: [], error: 'The code runner did not start. Run the tests again.' }
  }
  const id = `run${Date.now().toString(36)}${++counter}`
  // Python's first run also loads the runtime; give it a generous ceiling on the host side.
  const hostTimeout = timeoutMs + (language === 'python' ? 70_000 : 3_000)
  return new Promise<CodeRunResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, output: [], tests: [], error: 'The code runner did not respond.' })
    }, hostTimeout)
    pending.set(id, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    const msg: RunRequest = { type: 'run', id, language, code, tests, timeoutMs }
    target.postMessage(msg, '*')
  })
}
