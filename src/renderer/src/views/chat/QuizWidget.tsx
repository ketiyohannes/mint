import { useState, type JSX } from 'react'
import type { QuizQuestion } from '@shared/types'
import { RichText } from '../../components/RichText'
import { Icon } from '../../components/Icon'

interface Props {
  title: string
  questions: QuizQuestion[]
  choices?: number[]
  onSubmit?: (choices: number[]) => void
}

/** Retrieval practice: answer every question, then see what was right and why. */
export function QuizWidget({ title, questions, choices, onSubmit }: Props): JSX.Element {
  const [picked, setPicked] = useState<number[]>(() => questions.map(() => -1))
  const graded = Boolean(choices)
  const shown = choices ?? picked
  const score = choices ? choices.filter((c, i) => c === questions[i].answer).length : 0
  const complete = picked.every((c) => c >= 0)

  return (
    <div className="widget quiz" data-testid="quiz">
      <div className="widget-head">
        <Icon name="quiz" size={14} /> <b>{title}</b>
        <span className="spacer" />
        {graded && (
          <span className={`badge ${score === questions.length ? 'green' : score ? 'amber' : 'red'}`} data-testid="quiz-score">
            {score}/{questions.length}
          </span>
        )}
      </div>
      {questions.map((q, i) => (
        <div key={i} className="quiz-q">
          <div className="quiz-prompt">
            <span className="muted">{i + 1}.</span> <RichText text={q.prompt} inline />
          </div>
          <div className="quiz-options">
            {q.options.map((o, j) => {
              const mine = shown[i] === j
              const state = graded ? (j === q.answer ? 'right' : mine ? 'wrong' : '') : mine ? 'on' : ''
              return (
                <button
                  key={j}
                  className={`quiz-option ${state}`}
                  disabled={graded || !onSubmit}
                  onClick={() => setPicked((p) => p.map((c, k) => (k === i ? j : c)))}
                  data-testid="quiz-option"
                >
                  <span className="qw-key">{String.fromCharCode(65 + j)}</span>
                  <RichText text={o} inline />
                </button>
              )
            })}
          </div>
          {graded && (
            <div className={`quiz-expl ${choices![i] === q.answer ? 'right' : 'wrong'}`}>
              <b>{choices![i] === q.answer ? 'Right.' : choices![i] < 0 ? 'Skipped.' : 'Not quite.'}</b>{' '}
              <RichText text={q.explanation} inline />
            </div>
          )}
        </div>
      ))}
      {!graded && (
        <div className="widget-foot">
          <span className="muted small">{picked.filter((c) => c >= 0).length}/{questions.length} answered</span>
          <span className="spacer" />
          <button className="btn sm primary" disabled={!onSubmit || !complete} onClick={() => onSubmit?.(picked)} data-testid="quiz-submit">
            {!onSubmit ? <span className="spinner tiny" /> : null} Check answers
          </button>
        </div>
      )}
    </div>
  )
}
