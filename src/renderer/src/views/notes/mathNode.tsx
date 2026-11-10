import { useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { InputRule, mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { renderMath } from '../../lib/markdown'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      /** Insert a formula and open it for editing. */
      insertMath: (attrs?: { latex?: string; display?: boolean }) => ReturnType
    }
  }
}

/**
 * A LaTeX formula inside a note. Type `$x^2$` (or `$$…$$` for a display
 * formula), or use the toolbar. Click a formula to edit its source.
 * Stored in the note's HTML as `<span data-math data-latex="…">`.
 */
export const MathNode = Node.create({
  name: 'math',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: { default: '', parseHTML: (el) => el.getAttribute('data-latex') ?? el.textContent ?? '' },
      display: { default: false, parseHTML: (el) => el.getAttribute('data-display') === 'true' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-math]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-math': '', 'data-latex': node.attrs.latex, 'data-display': String(node.attrs.display) }), node.attrs.latex]
  },

  renderText({ node }) {
    return node.attrs.display ? `$$${node.attrs.latex}$$` : `$${node.attrs.latex}$`
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathView)
  },

  addCommands() {
    return {
      insertMath:
        (attrs = {}) =>
        ({ chain, state }) => {
          const at = state.selection.from
          return chain()
            .insertContent({ type: this.name, attrs: { latex: attrs.latex ?? '', display: attrs.display ?? false } })
            .setNodeSelection(at)
            .run()
        }
    }
  },

  addInputRules() {
    const type = this.type
    return [
      // $$…$$ : a display formula.
      new InputRule({
        find: /\$\$([^$\n]+)\$\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, type.create({ latex: match[1].trim(), display: true }))
        }
      }),
      // $…$ : an inline formula (not after another $ or a backslash, so "$$" and "\$" still type normally;
      // no space just inside the dollars, so "$5 and $10" stays a pair of prices).
      new InputRule({
        find: /(^|[^$\\])\$([^\s$](?:[^$\n]*[^\s$])?)\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from + match[1].length, range.to, type.create({ latex: match[2].trim() }))
        }
      })
    ]
  }
})

function MathView({ node, selected, updateAttributes, deleteNode, editor, getPos }: ReactNodeViewProps): JSX.Element {
  const latex = String(node.attrs.latex ?? '')
  const display = Boolean(node.attrs.display)
  const html = useMemo(() => renderMath(latex || '\\square', display), [latex, display])

  const leave = () => {
    const pos = getPos()
    if (!latex.trim()) deleteNode()
    else if (typeof pos === 'number')
      editor
        .chain()
        .focus()
        .setTextSelection(pos + node.nodeSize)
        .run()
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter that confirms an IME candidate stays in the box.
    if ((e.key === 'Enter' || e.key === 'Escape') && !e.nativeEvent.isComposing) {
      e.preventDefault()
      leave()
    }
  }

  // Near the note's right edge the source box opens leftwards, so it stays inside the note.
  const editRef = useRef<HTMLSpanElement>(null)
  const [flip, setFlip] = useState(false)
  useLayoutEffect(() => {
    const box = editRef.current
    const pane = box?.closest('.note-scroll')
    setFlip(Boolean(selected && box && pane && box.getBoundingClientRect().right > pane.getBoundingClientRect().right - 8))
  }, [selected])

  return (
    <NodeViewWrapper as="span" className={`note-math ${display ? 'display' : ''} ${selected ? 'selected' : ''}`} data-testid="note-math">
      {selected && editor.isEditable && (
        <span ref={editRef} className={`note-math-edit ${flip ? 'end' : ''}`} contentEditable={false}>
          <input
            autoFocus
            value={latex}
            placeholder="LaTeX, e.g. A\mathbf{v} = \lambda\mathbf{v}"
            onChange={(e) => updateAttributes({ latex: e.target.value })}
            onKeyDown={onKey}
            spellCheck={false}
            data-testid="note-math-input"
          />
        </span>
      )}
      <span className="note-math-render" contentEditable={false} dangerouslySetInnerHTML={{ __html: html }} />
    </NodeViewWrapper>
  )
}
