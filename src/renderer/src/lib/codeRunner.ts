import type { CodeLanguage, CodeRunResult } from '@shared/types'
import { CODE_RUNNER_URL, isRunnerMessage, type RunRequest } from '@shared/diagramProtocol'

/**
 * Runs learner code in the sandboxed runner frame (opaque origin, no network,
 * workers with timeouts). One hidden frame is shared by every code widget.
 */
let frame: HTMLIFrameElement | null = null
let ready: Promise<void> | null = null
const pending = new Map<string, (r: CodeRunResult) => void>()
let counter = 0

function ensureFrame(): Promise<void> {
  if (ready && frame?.isConnected) return ready
  frame?.remove()
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
  })
  document.body.appendChild(el)
  return ready
}

export async function runCode(language: CodeLanguage, code: string, tests: string, timeoutMs = 5000): Promise<CodeRunResult> {
  await ensureFrame()
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
    frame!.contentWindow!.postMessage(msg, '*')
  })
}
