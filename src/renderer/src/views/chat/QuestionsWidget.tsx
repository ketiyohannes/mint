import { useEffect, useRef, useState, type JSX } from 'react'
import type { ChoiceQuestion } from '@shared/types'
import { Icon } from '../../components/Icon'
import { RichText } from '../../components/RichText'

interface Props {
  questions: ChoiceQuestion[]
  answers?: Record<string, string[]>
  skipped?: boolean
  /** Undefined while sending. */
  onSubmit?: (answers: Record<string, string[]>) => void
  onSkip?: () => void
}

/**
 * Multiple-choice questions asked the way a coding agent asks: one at a time,
 * options with descriptions, number keys to pick, and "Other" to type your own.
 */
export function QuestionsWidget({ questions, answers, skipped, onSubmit, onSkip }: Props): JSX.Element {
  const [index, setIndex] = useState(0)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const done = Boolean(answers || skipped)

  useEffect(() => {
    if (!done) rootRef.current?.focus()
  }, [done])

  if (done) {
    return (
      <div className="qw done" data-testid="questions-done">
        {skipped ? (
          <span className="muted">Skipped</span>
        ) : (
          questions.map((q) => (
            <div key={q.id} className="qw-summary">
              <span className="qw-chip">{q.header}</span> {answers?.[q.id]?.join(', ') || <span className="muted">no answer</span>}
            </div>
          ))
        )}
      </div>
    )
  }

  const q = questions[Math.min(index, questions.length - 1)]
  const chosen = picked[q.id] ?? []
  const otherText = other[q.id] ?? ''
  const valueFor = (id: string) => [...(picked[id] ?? []), ...(otherOpen[id] && other[id]?.trim() ? [other[id].trim()] : [])]
  const answered = (id: string) => valueFor(id).length > 0
  const last = index >= questions.length - 1
  const sending = !onSubmit

  const toggle = (label: string) => {
    setPicked((p) => {
      const cur = p[q.id] ?? []
      if (q.multiSelect) return { ...p, [q.id]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
      return { ...p, [q.id]: cur[0] === label ? [] : [label] }
    })
    if (!q.multiSelect) {
      setOtherOpen((o) => ({ ...o, [q.id]: false }))
      // Single choice: move on, like picking an answer in a terminal prompt.
      if (!last) setTimeout(() => setIndex((i) => Math.min(i + 1, questions.length - 1)), 120)
    }
  }

  const submit = () => {
    if (sending) return
    const out: Record<string, string[]> = {}
    for (const x of questions) if (answered(x.id)) out[x.id] = valueFor(x.id)
    onSubmit?.(out)
  }

  return (
    <div
      className="qw"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return
        const n = Number(e.key)
        if (n >= 1 && n <= q.options.length) {
          e.preventDefault()
          toggle(q.options[n - 1].label)
        } else if (e.key === 'ArrowRight' && !last) setIndex(index + 1)
        else if (e.key === 'ArrowLeft' && index > 0) setIndex(index - 1)
        else if (e.key === 'Enter' && last) submit()
      }}
      data-testid="questions"
    >
      <div className="qw-tabs">
        {questions.map((x, i) => (
          <button key={x.id} className={`qw-tab ${i === index ? 'on' : ''} ${answered(x.id) ? 'answered' : ''}`} onClick={() => setIndex(i)}>
            {answered(x.id) ? <Icon name="check" size={11} strokeWidth={2.6} /> : null}
            {x.header}
          </button>
        ))}
      </div>
      <RichText text={q.question} className="qw-question" />
      <div className="qw-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
        {q.options.map((o, i) => {
          const on = chosen.includes(o.label)
          return (
            <button
              key={o.label}
              className={`qw-option ${on ? 'on' : ''}`}
              role={q.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              onClick={() => toggle(o.label)}
              data-testid="question-option"
            >
              <span className="qw-key">{q.multiSelect ? (on ? '■' : '□') : i + 1}</span>
              <span className="qw-label">
                <RichText text={o.label} inline />
                {o.description && <RichText text={o.description} inline className="qw-desc" />}
              </span>
            </button>
          )
        })}
        <div className={`qw-option other ${otherOpen[q.id] ? 'on' : ''}`}>
          <span className="qw-key">{q.multiSelect ? (otherOpen[q.id] ? '■' : '□') : q.options.length + 1}</span>
          <input
            className="qw-other"
            placeholder="Other: type your own answer"
            value={otherText}
            onFocus={() => {
              setOtherOpen((o) => ({ ...o, [q.id]: true }))
              if (!q.multiSelect) setPicked((p) => ({ ...p, [q.id]: [] }))
            }}
            onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (last) submit()
                else setIndex(index + 1)
              }
            }}
            data-testid="question-other"
          />
        </div>
      </div>
      <div className="qw-foot">
        <button className="btn ghost sm" onClick={onSkip} disabled={sending} data-testid="questions-skip">
          Skip
        </button>
        <span className="spacer" />
        <span className="muted small">{q.multiSelect ? 'Pick any' : 'Pick one'} · {index + 1}/{questions.length}</span>
        {last ? (
          <button className="btn sm primary" disabled={sending || !questions.some((x) => answered(x.id))} onClick={submit} data-testid="questions-submit">
            {sending ? <span className="spinner tiny" /> : null} Submit
          </button>
        ) : (
          <button className="btn sm" onClick={() => setIndex(index + 1)} data-testid="questions-next">
            Next <Icon name="arrow" size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
