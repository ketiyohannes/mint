import { useEffect, useRef, type JSX } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { keymap, placeholder as placeholderText } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { indentUnit, syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import type { LanguageId } from '@shared/languages'
import { codeLanguage, indentSize } from '../lib/codeLanguages'

const theme = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'var(--surface-2)', color: 'var(--fg)' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--surface-3) 60%, transparent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-placeholder': { color: 'var(--muted)' }
})

interface Props {
  language: LanguageId
  value: string
  onChange: (code: string) => void
  readOnly?: boolean
  /** Mod-Enter: run the code, or send the answer it is part of. */
  onRun?: () => void
  placeholder?: string
  /** Take the caret when the editor appears (a block the learner has just added). */
  autoFocus?: boolean
  testId?: string
}

/** The grammar and the indent step of a language. Colours come from the classes in styles.css (".tok-*"). */
const languageSetup = (id: LanguageId) => [codeLanguage(id) ?? [], indentUnit.of(' '.repeat(indentSize(id)))]

/** A small code editor (CodeMirror 6): exercises in the chat, and code in a lesson's answers. */
export function CodeEditor({ language, value, onChange, readOnly, onRun, placeholder, autoFocus, testId = 'code-editor' }: Props): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onRun })
  callbacks.current = { onChange, onRun }
  // Reconfigured in place: changing the language keeps the code, the caret and the undo history.
  const languageSlot = useRef(new Compartment())

  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        // Above the basic setup's own Mod-Enter (insert a blank line), which would otherwise win.
        Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (callbacks.current.onRun?.(), true) }])),
        keymap.of([indentWithTab]),
        languageSlot.current.of(languageSetup(language)),
        syntaxHighlighting(classHighlighter),
        theme,
        placeholder ? placeholderText(placeholder) : [],
        EditorState.readOnly.of(Boolean(readOnly)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) callbacks.current.onChange(u.state.doc.toString())
        })
      ]
    })
    view.current = new EditorView({ state, parent: host.current! })
    if (autoFocus) view.current.focus()
    return () => {
      view.current?.destroy()
      view.current = null
    }
    // The editor owns its document after mount; external resets and the language go through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly])

  useEffect(() => {
    view.current?.dispatch({ effects: languageSlot.current.reconfigure(languageSetup(language)) })
  }, [language])

  // Replace the document when the value is reset from outside (e.g. "Reset to starter").
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])

  return <div className="code-editor" ref={host} data-testid={testId} data-language={language} />
}
