import { useEffect, useState, type JSX } from 'react'
import type { CodeExercise, CodeRunResult } from '@shared/types'
import { CodeEditor } from '../../components/CodeEditor'
import { RichText } from '../../components/RichText'
import { Icon } from '../../components/Icon'
import { runCode } from '../../lib/codeRunner'
import { api } from '../../lib/api'
import { codeDraftKey, readDraft, writeDraft } from '../../lib/drafts'
import { shortcutLabel } from '../../lib/shortcuts'
import { useStudy } from '../study/context'
import { useChat } from './chatContext'

interface Props {
  messageId: string
  exercise: CodeExercise
  submission?: { code: string; passed: number; total: number }
}

/** A small IDE in the chat: edit, run the tests in the sandbox, then submit for the tutor's review. */
export function CodeWidget({ messageId, exercise, submission }: Props): JSX.Element {
  const study = useStudy()
  const chat = useChat()
  // Unsent code survives leaving the chat and a restart; what was submitted (or the starter) needs no copy.
  const saved = submission?.code ?? exercise.starter
  const [code, setCode] = useState(() => readDraft(codeDraftKey(messageId)) || saved)
  useEffect(() => writeDraft(codeDraftKey(messageId), code === saved ? '' : code), [messageId, code, saved])
  const [result, setResult] = useState<CodeRunResult | null>(null)
  const [running, setRunning] = useState(false)
  const [hint, setHint] = useState(false)

  async function run(): Promise<CodeRunResult> {
    setRunning(true)
    try {
      const r = await runCode(exercise.language, code, exercise.tests)
      setResult(r)
      return r
    } finally {
      setRunning(false)
    }
  }

  async function submit() {
    const r = await run()
    await chat.stream((streamId) => api.chat.answer({ classId: study.classId, threadId: chat.threadId, messageId, answer: { kind: 'code', code, result: r, streamId } }))
  }

  const passed = result?.tests.filter((t) => t.pass).length ?? 0
  return (
    <div className="widget code" data-testid="code-widget">
      <div className="widget-head">
        <Icon name="code" size={14} /> <b>{exercise.title}</b>
        <span className="badge">{exercise.language}</span>
        <span className="spacer" />
        {submission && (
          <span className={`badge ${submission.passed === submission.total && submission.total ? 'green' : 'amber'}`}>
            submitted {submission.passed}/{submission.total}
          </span>
        )}
      </div>
      <RichText text={exercise.prompt} />
      <CodeEditor language={exercise.language} value={code} onChange={setCode} onRun={() => void run()} />
      <div className="widget-foot">
        <button className="btn sm" disabled={running} onClick={() => void run()} title={`Run the tests (${shortcutLabel('runTests')})`} data-testid="code-run">
          {running ? <span className="spinner tiny" /> : <Icon name="play" size={11} />} Run tests
        </button>
        <button className="btn sm primary" disabled={running || chat.busy || !code.trim()} onClick={() => void submit()} data-testid="code-submit">
          Submit for review
        </button>
        <span className="spacer" />
        {exercise.hint && (
          <button className="btn ghost sm" onClick={() => setHint((h) => !h)}>
            {hint ? 'Hide hint' : 'Hint'}
          </button>
        )}
        <button className="btn ghost sm" onClick={() => setCode(exercise.starter)} title="Reset to the starter code" data-testid="code-reset">
          Reset
        </button>
      </div>
      {hint && exercise.hint && <RichText text={`**Hint:** ${exercise.hint}`} className="small muted" />}
      {result && (
        <div className="run-output" data-testid="code-output">
          {result.tests.length > 0 && (
            <div className="run-summary">
              <b className={passed === result.tests.length ? 'ok' : 'fail'}>
                {passed}/{result.tests.length} tests passing
              </b>
            </div>
          )}
          {result.tests.map((t, i) => (
            <div key={i} className={`run-test ${t.pass ? 'ok' : 'fail'}`}>
              {t.pass ? '✓' : '✗'} {t.name}
              {t.message && <span className="muted"> · {t.message}</span>}
            </div>
          ))}
          {result.error && <pre className="run-error">{result.error}</pre>}
          {result.output.length > 0 && <pre className="run-console">{result.output.join('\n')}</pre>}
          {!result.error && !result.tests.length && !result.output.length && <div className="muted small">Ran with no output.</div>}
        </div>
      )}
    </div>
  )
}
