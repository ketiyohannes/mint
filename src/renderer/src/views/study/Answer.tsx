import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { formatAnswer, parseAnswer, type AnswerPart } from '@shared/answer'
import { CODE_LANGUAGES, languageFromName, type LanguageId } from '@shared/languages'
import { CodeBlock } from '../../components/CodeBlock'
import { CodeEditor } from '../../components/CodeEditor'
import { Icon } from '../../components/Icon'

/** The language of the last code block the learner wrote: the next one starts in it. */
const LANGUAGE_KEY = 'mint.answerLanguage'

function lastLanguage(): LanguageId {
  try {
    return languageFromName(localStorage.getItem(LANGUAGE_KEY)) ?? 'python'
  } catch {
    return 'python'
  }
}

function rememberLanguage(language: LanguageId): void {
  try {
    localStorage.setItem(LANGUAGE_KEY, language)
  } catch {
    // The next block starts in Python.
  }
}

type Part = AnswerPart & { key: number }

/** Text parts that end up next to each other become one, and the box is never without a part to write in. */
function tidy(parts: Part[], nextKey: () => number): Part[] {
  const out: Part[] = []
  for (const part of parts) {
    const before = out[out.length - 1]
    if (part.type === 'text' && before?.type === 'text') out[out.length - 1] = { ...before, text: [before.text.trimEnd(), part.text.trimStart()].filter(Boolean).join('\n\n') }
    else out.push(part)
  }
  return out.length ? out : [{ type: 'text', text: '', key: nextKey() }]
}

interface EditorProps {
  /** The answer as it was last written (a draft, or a try that did not pass), to go on from. */
  initial: string
  /** The check asks for code in this language: the box starts as a code editor. */
  codeLanguage?: LanguageId
  placeholder: string
  /** What to keep while the answer is unsent: the answer, with any code block that is still empty. */
  onDraft: (draft: string) => void
  /** Mod-Enter, from the text or the code, with the answer as it is at that moment. */
  onSubmit: (answer: string) => void
  /** The submit button and its hint, shown on the line of the buttons that add parts. `send` submits the answer. */
  children: (state: { empty: boolean; send: () => void }) => ReactNode
}

/**
 * The box a check is answered in: text, and code in any of the languages, in
 * the order the learner wants them. "Code" adds a block; so does typing ```
 * (or ```rust) on a line of its own and pressing Enter.
 */
export function AnswerEditor({ initial, codeLanguage, placeholder, onDraft, onSubmit, children }: EditorProps): JSX.Element {
  const keys = useRef(0)
  const nextKey = () => ++keys.current
  const [parts, setParts] = useState<Part[]>(() => {
    const saved = parseAnswer(initial).map((p) => ({ ...p, key: nextKey() }))
    if (saved.length) return saved
    return [codeLanguage ? { type: 'code', language: codeLanguage, code: '', key: nextKey() } : { type: 'text', text: '', key: nextKey() }]
  })
  /**
   * The parts as of the last keystroke. What is sent is read from here: the
   * rendered state can be a moment behind the keys, and Mod-Enter straight
   * after the last one would send the answer without it.
   */
  const latest = useRef(parts)
  const change = (to: (list: Part[]) => Part[]): void => {
    latest.current = to(latest.current)
    setParts(latest.current)
  }
  const submit = () => onSubmit(formatAnswer(latest.current))
  /** The part that was just added takes the caret. */
  const [focus, setFocus] = useState<number | null>(null)
  const drafted = useRef(onDraft)
  drafted.current = onDraft

  useEffect(() => {
    drafted.current(formatAnswer(parts) ? formatAnswer(parts, { keepEmpty: true }) : '')
  }, [parts])

  const update = (key: number, to: Partial<AnswerPart>) => change((list) => list.map((p) => (p.key === key ? ({ ...p, ...to } as Part) : p)))

  function addCode(): void {
    const block: Part = { type: 'code', language: codeLanguage ?? lastLanguage(), code: '', key: nextKey() }
    // A text box left empty next to the new block would only be in the way ("Text" adds one back).
    change((list) => [...list, block].filter((p) => p.type === 'code' || p.text.trim()))
    setFocus(block.key)
  }

  function addText(): void {
    const text: Part = { type: 'text', text: '', key: nextKey() }
    change((list) => tidy([...list, text], nextKey))
    setFocus(text.key)
  }

  function remove(key: number): void {
    change((list) =>
      tidy(
        list.filter((p) => p.key !== key),
        nextKey
      )
    )
  }

  /** A fence typed on a line of its own, then Enter: the line becomes a code block, and the text around it stays. */
  function fenceToBlock(e: KeyboardEvent<HTMLTextAreaElement>, part: Part & { type: 'text' }): boolean {
    const box = e.currentTarget
    const at = box.selectionStart
    if (at !== box.selectionEnd) return false
    const lineStart = part.text.lastIndexOf('\n', at - 1) + 1
    const lineEnd = part.text.indexOf('\n', at)
    const fence = /^```\s*([^\s`]*)$/.exec(part.text.slice(lineStart, at))
    if (!fence || part.text.slice(at, lineEnd < 0 ? undefined : lineEnd).trim()) return false
    const before = part.text.slice(0, lineStart).trimEnd()
    const after = part.text.slice(lineEnd < 0 ? part.text.length : lineEnd + 1).trimStart()
    const block: Part = { type: 'code', language: languageFromName(fence[1]) ?? codeLanguage ?? lastLanguage(), code: '', key: nextKey() }
    change((list) =>
      list.flatMap((p): Part[] => {
        if (p.key !== part.key) return [p]
        return [...(before ? [{ ...part, text: before }] : []), block, ...(after ? [{ type: 'text' as const, text: after, key: nextKey() }] : [])]
      })
    )
    setFocus(block.key)
    return true
  }

  function onTextKey(e: KeyboardEvent<HTMLTextAreaElement>, part: Part & { type: 'text' }): void {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      submit()
    } else if (!e.shiftKey && !e.altKey && fenceToBlock(e, part)) {
      e.preventDefault()
    }
  }

  const alone = parts.length === 1
  return (
    <div className="stack answer-editor" style={{ gap: 8 }} data-testid="answer-editor">
      {parts.map((part) =>
        part.type === 'text' ? (
          <textarea
            key={part.key}
            // Alone, the box keeps its fixed height; among code blocks it is as tall as its text.
            className={`textarea check-answer ${alone ? '' : 'fitted'}`}
            placeholder={alone ? placeholder : 'Text…'}
            value={part.text}
            autoFocus={focus === part.key}
            onChange={(e) => update(part.key, { text: e.target.value })}
            onKeyDown={(e) => onTextKey(e, part)}
            data-testid="check-answer"
          />
        ) : (
          <div key={part.key} className="answer-code" data-testid="answer-code">
            <div className="answer-code-head">
              <Icon name="code" size={13} />
              <select
                className="answer-code-lang"
                value={part.language}
                aria-label="Language"
                onChange={(e) => {
                  const language = languageFromName(e.target.value) ?? 'plain'
                  rememberLanguage(language)
                  update(part.key, { language })
                }}
                data-testid="answer-code-lang"
              >
                {CODE_LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
              <span className="spacer" />
              <button className="icon-btn" aria-label="Remove this code block" title="Remove this code block" onClick={() => remove(part.key)} data-testid="answer-code-remove">
                <Icon name="x" size={12} />
              </button>
            </div>
            <CodeEditor
              language={part.language}
              value={part.code}
              onChange={(code) => update(part.key, { code })}
              onRun={submit}
              placeholder="Your code…"
              autoFocus={focus === part.key}
              testId="answer-code-editor"
            />
          </div>
        )
      )}
      <div className="row answer-actions">
        {children({ empty: !formatAnswer(parts), send: submit })}
        {parts[parts.length - 1].type === 'code' && (
          <button className="btn ghost sm" onClick={addText} title="Add text below the code" data-testid="answer-add-text">
            <Icon name="term" size={13} /> Text
          </button>
        )}
        <button className="btn ghost sm" onClick={addCode} title="Add a code block (or type ``` on a line of its own and press Enter)" data-testid="answer-add-code">
          <Icon name="code" size={13} /> Code
        </button>
      </div>
    </div>
  )
}

/** An answer as it was sent: the text as written, and each code block coloured, with its language. */
export function AnswerView({ answer }: { answer: string }): JSX.Element {
  const parts = useMemo(() => parseAnswer(answer), [answer])
  return (
    <div className="msg user answer-shown" data-testid="answer-shown">
      {parts.length === 0 && answer}
      {parts.map((part, i) => (part.type === 'text' ? <div key={i}>{part.text}</div> : <CodeBlock key={i} code={part.code} language={part.language} />))}
    </div>
  )
}
