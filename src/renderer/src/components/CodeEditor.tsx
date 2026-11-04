import { useEffect, useRef, type JSX } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import type { CodeLanguage } from '@shared/types'

const theme = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'var(--surface-2)', color: 'var(--fg)' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--surface-3) 60%, transparent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' }
})

interface Props {
  language: CodeLanguage
  value: string
  onChange: (code: string) => void
  readOnly?: boolean
  /** Mod-Enter runs the code. */
  onRun?: () => void
}

/** A small code editor (CodeMirror 6) for exercises inside the chat. */
export function CodeEditor({ language, value, onChange, readOnly, onRun }: Props): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onRun })
  callbacks.current = { onChange, onRun }

  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        keymap.of([{ key: 'Mod-Enter', run: () => (callbacks.current.onRun?.(), true) }, indentWithTab]),
        language === 'python' ? python() : javascript(),
        theme,
        EditorState.readOnly.of(Boolean(readOnly)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) callbacks.current.onChange(u.state.doc.toString())
        })
      ]
    })
    view.current = new EditorView({ state, parent: host.current! })
    return () => {
      view.current?.destroy()
      view.current = null
    }
    // The editor owns its document after mount; external resets go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly])

  // Replace the document when the value is reset from outside (e.g. "Reset to starter").
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])

  return <div className="code-editor" ref={host} data-testid="code-editor" />
}
