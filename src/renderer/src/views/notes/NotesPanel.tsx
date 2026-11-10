import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import Typography from '@tiptap/extension-typography'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CodeBlockIcon,
  CodeIcon,
  EraserIcon,
  HighlighterIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  ListChecksIcon,
  ListNumbersIcon,
  MathOperationsIcon,
  MinusIcon,
  QuotesIcon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBIcon,
  TextHOneIcon,
  TextHThreeIcon,
  TextHTwoIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextSubscriptIcon,
  TextSuperscriptIcon,
  TextUnderlineIcon,
  type Icon as PhosphorIcon
} from '@phosphor-icons/react'
import type { ClassBundle, NoteDoc } from '@shared/types'
import { api, errorMessage, timeAgo } from '../../lib/api'
import { markdownToNoteHtml, renderMath } from '../../lib/markdown'
import { useApp } from '../../state/app'
import { Icon } from '../../components/Icon'
import { shortcutLabel, withMod } from '../../lib/shortcuts'
import { MathNode } from './mathNode'

/**
 * The Notes tab: a plain notepad. A list of everything you have written,
 * newest first, and a rich editor for one note at a time. Saves as you type.
 */
export function NotesPanel({ bundle }: { bundle: ClassBundle }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const notes = useMemo(() => [...bundle.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [bundle.notes])

  if (open) {
    const note = open === NEW ? null : (notes.find((n) => n.id === open) ?? null)
    return <NoteEditor key={open} classId={bundle.meta.id} note={note} onClose={() => setOpen(null)} />
  }

  const q = query.trim().toLowerCase()
  const shown = q ? notes.filter((n) => n.title.toLowerCase().includes(q) || plainText(n).replaceAll(MATH_MARK, '').toLowerCase().includes(q)) : notes

  return (
    <div className="notes" data-testid="notes">
      <div className="notes-bar">
        <label className="notes-search">
          <Icon name="search" size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes" data-testid="notes-search" />
        </label>
        <button className="btn sm primary" onClick={() => setOpen(NEW)} data-testid="note-new">
          <Icon name="plus" size={13} /> New note
        </button>
      </div>
      <div className="notes-list">
        {shown.map((n) => (
          <button key={n.id} className="note-row" onClick={() => setOpen(n.id)} data-testid="note-row">
            <span className="note-row-head">
              <b className="ellipsis">{n.title || 'Untitled'}</b>
              <span className="note-row-time">{timeAgo(n.updatedAt)}</span>
            </span>
            <span className="note-row-snippet">
              <Snippet text={plainText(n).slice(0, 200)} />
            </span>
          </button>
        ))}
        {!notes.length && (
          <div className="notes-empty">
            <Icon name="note" size={20} />
            <p>Your notes live here. Write down what you understood, in your own words.</p>
            <button className="btn sm" onClick={() => setOpen(NEW)}>
              <Icon name="plus" size={13} /> Write your first note
            </button>
          </div>
        )}
        {notes.length > 0 && !shown.length && <div className="notes-empty muted">No notes match “{query}”.</div>}
      </div>
    </div>
  )
}

const NEW = '__new__'

/** A preview line: plain text, with formulas drawn by the shared math renderer. */
function Snippet({ text }: { text: string }): JSX.Element {
  if (!text) return <>Empty note</>
  const parts = text.split(MATH_MARK)
  return <>{parts.map((part, i) => (i % 2 ? <span key={i} dangerouslySetInnerHTML={{ __html: renderMath(part) }} /> : <span key={i}>{part}</span>))}</>
}

const MATH_MARK = '\u0000'

/** Text of a note for previews and search (never rendered as HTML). Formulas are wrapped in MATH_MARK. */
function plainText(n: NoteDoc): string {
  if (n.format === 'html') {
    // Separate blocks with a space so lines do not run together ("done.Review").
    const spaced = n.body.replace(/<(\/(?:p|h[1-6]|li|blockquote|pre)|br|hr)\b/gi, ' <$1')
    const body = new DOMParser().parseFromString(spaced, 'text/html').body
    for (const el of Array.from(body.querySelectorAll('span[data-math]'))) el.textContent = `${MATH_MARK}${el.getAttribute('data-latex') ?? ''}${MATH_MARK}`
    return (body.textContent ?? '').replace(/\s+/g, ' ').trim()
  }
  return n.body
    .replace(/[#>*_`~[\]()$|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function NoteEditor({ classId, note, onClose }: { classId: string; note: NoteDoc | null; onClose: () => void }): JSX.Element {
  const { toast } = useApp()
  const [title, setTitle] = useState(note?.title === 'Untitled' ? '' : (note?.title ?? ''))
  const [status, setStatus] = useState<SaveState>('idle')
  const idRef = useRef<string | undefined>(note?.id)
  const titleRef = useRef(title)
  titleRef.current = title
  const dirty = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  /** Saves run one at a time so a new note is created exactly once. */
  const queue = useRef<Promise<void>>(Promise.resolve())

  const initial = useMemo(() => (note ? (note.format === 'html' ? note.body : markdownToNoteHtml(note.body)) : ''), []) // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] } }),
      Highlight,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Subscript,
      Superscript,
      Typography,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start writing… (type $x^2$ for a formula)' }),
      MathNode
    ],
    content: initial,
    // A new note starts in the title; the body is focused on Enter (never stolen mid-typing).
    autofocus: false,
    editorProps: {
      attributes: { class: 'note-doc', 'data-testid': 'note-editor', spellcheck: 'true' },
      // A plain click on a link places the cursor; ⌘/Ctrl + click opens it in the browser.
      handleClick: (_view, _pos, event) => {
        const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
        if (!link || !(event.metaKey || event.ctrlKey) || !/^https?:\/\//i.test(link.href)) return false
        void api.system.openExternal(link.href).catch((err) => toast(errorMessage(err), 'error'))
        return true
      }
    },
    onUpdate: () => schedule()
  })

  const save = () => {
    if (!editor || editor.isDestroyed || !dirty.current) return queue.current
    dirty.current = false
    const body = editor.getHTML()
    const empty = editor.isEmpty && !titleRef.current.trim()
    // A brand-new note that is still blank is not worth keeping.
    if (!idRef.current && empty) return queue.current
    queue.current = queue.current.then(async () => {
      setStatus('saving')
      try {
        const saved = await api.notes.save(classId, { id: idRef.current, kind: note?.kind ?? 'note', title: titleRef.current.trim() || firstLine(editor), body, format: 'html' })
        idRef.current = saved.id
        setStatus('saved')
      } catch (err) {
        dirty.current = true
        setStatus('error')
        toast(errorMessage(err), 'error')
      }
    })
    return queue.current
  }
  const saveRef = useRef(save)
  saveRef.current = save

  function schedule() {
    dirty.current = true
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void saveRef.current(), 600)
  }

  // Leaving the editor (or the tab) flushes any pending change.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      void saveRef.current()
    },
    []
  )

  const close = async () => {
    window.clearTimeout(timer.current)
    await save()
    // Still unsaved (the save failed, and said so): leaving would drop the changes.
    if (dirty.current && !window.confirm('This note could not be saved. Leave it and lose your last changes?')) return
    dirty.current = false
    onClose()
  }

  const remove = async () => {
    await queue.current
    // Asked first: on "Cancel" the note is as it was, unsaved changes included.
    if (idRef.current && !window.confirm('Delete this note?')) return
    window.clearTimeout(timer.current)
    dirty.current = false
    if (idRef.current) {
      try {
        await api.notes.remove(classId, idRef.current)
      } catch (err) {
        toast(errorMessage(err), 'error')
        return
      }
    }
    onClose()
  }

  return (
    <div className="note-editor-pane" data-testid="note-editor-pane">
      <div className="note-top">
        <button className="icon-btn" onClick={() => void close()} title="All notes" aria-label="All notes" data-testid="note-back">
          <Icon name="back" size={15} />
        </button>
        <span className="note-status" data-testid="note-status">
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Not saved' : note ? `Edited ${timeAgo(note.updatedAt)}` : 'New note'}
        </span>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => void remove()} title="Delete note" aria-label="Delete note" data-testid="note-delete">
          <Icon name="trash" size={14} />
        </button>
      </div>
      {editor && <Toolbar editor={editor} />}
      <div className="note-scroll" onMouseDown={(e) => e.target === e.currentTarget && editor?.commands.focus('end')}>
        <input
          className="note-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            schedule()
          }}
          onKeyDown={(e) => {
            // Enter that confirms an IME candidate stays in the title.
            if ((e.key === 'Enter' || e.key === 'ArrowDown') && editor && !e.nativeEvent.isComposing) {
              e.preventDefault()
              // Focus synchronously (TipTap's focus command waits a frame, and fast typing would land in the title).
              editor.view.focus()
              editor.commands.focus('start')
            }
          }}
          placeholder="Title"
          autoFocus={!note}
          data-testid="note-title"
        />
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}

function firstLine(editor: Editor): string {
  return (
    editor
      .getText()
      .split('\n')
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 80) || 'Untitled'
  )
}

// ---------------------------------------------------------------------------
// Formatting toolbar
// ---------------------------------------------------------------------------

function Toolbar({ editor }: { editor: Editor }): JSX.Element {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      highlight: e.isActive('highlight'),
      code: e.isActive('code'),
      sub: e.isActive('subscript'),
      sup: e.isActive('superscript'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
      center: e.isActive({ textAlign: 'center' }),
      right: e.isActive({ textAlign: 'right' }),
      canUndo: e.can().undo(),
      canRedo: e.can().redo()
    })
  })
  const [linking, setLinking] = useState<string | null>(null)
  const c = () => editor.chain().focus()

  const applyLink = () => {
    const raw = (linking ?? '').trim()
    setLinking(null)
    if (!raw) return void editor.commands.focus()
    const href = /^(https?:|mailto:)/i.test(raw) ? raw : `https://${raw}`
    // Nothing selected: the address itself becomes the linked text (a link on no text would not show).
    if (editor.state.selection.empty && !editor.isActive('link')) {
      c()
        .insertContent({ type: 'text', text: raw, marks: [{ type: 'link', attrs: { href } }] })
        .unsetMark('link')
        .run()
    } else c().extendMarkRange('link').setLink({ href }).run()
  }

  return (
    <div className="note-toolbar" role="toolbar" aria-label="Formatting" onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && e.preventDefault()}>
      <Group>
        <Btn icon={ArrowCounterClockwiseIcon} label="Undo" disabled={!s.canUndo} onClick={() => c().undo().run()} />
        <Btn icon={ArrowClockwiseIcon} label="Redo" disabled={!s.canRedo} onClick={() => c().redo().run()} />
      </Group>
      <Group>
        <Btn icon={TextHOneIcon} label="Heading 1" on={s.h1} onClick={() => c().toggleHeading({ level: 1 }).run()} />
        <Btn icon={TextHTwoIcon} label="Heading 2" on={s.h2} onClick={() => c().toggleHeading({ level: 2 }).run()} />
        <Btn icon={TextHThreeIcon} label="Heading 3" on={s.h3} onClick={() => c().toggleHeading({ level: 3 }).run()} />
      </Group>
      <Group>
        <Btn icon={TextBIcon} label={`Bold (${shortcutLabel('bold')})`} on={s.bold} onClick={() => c().toggleBold().run()} testId="fmt-bold" />
        <Btn icon={TextItalicIcon} label={`Italic (${shortcutLabel('italic')})`} on={s.italic} onClick={() => c().toggleItalic().run()} />
        <Btn icon={TextUnderlineIcon} label={`Underline (${shortcutLabel('underline')})`} on={s.underline} onClick={() => c().toggleUnderline().run()} />
        <Btn icon={TextStrikethroughIcon} label="Strikethrough" on={s.strike} onClick={() => c().toggleStrike().run()} />
        <Btn icon={HighlighterIcon} label="Highlight" on={s.highlight} onClick={() => c().toggleHighlight().run()} />
        <Btn icon={CodeIcon} label="Inline code" on={s.code} onClick={() => c().toggleCode().run()} />
        <Btn icon={TextSubscriptIcon} label="Subscript" on={s.sub} onClick={() => c().toggleSubscript().run()} />
        <Btn icon={TextSuperscriptIcon} label="Superscript" on={s.sup} onClick={() => c().toggleSuperscript().run()} />
      </Group>
      <Group>
        <Btn icon={ListBulletsIcon} label="Bulleted list" on={s.bullet} onClick={() => c().toggleBulletList().run()} />
        <Btn icon={ListNumbersIcon} label="Numbered list" on={s.ordered} onClick={() => c().toggleOrderedList().run()} />
        <Btn icon={ListChecksIcon} label="Checklist" on={s.task} onClick={() => c().toggleTaskList().run()} testId="fmt-checklist" />
      </Group>
      <Group>
        <Btn icon={QuotesIcon} label="Quote" on={s.quote} onClick={() => c().toggleBlockquote().run()} />
        <Btn icon={CodeBlockIcon} label="Code block" on={s.codeBlock} onClick={() => c().toggleCodeBlock().run()} />
        <Btn icon={MathOperationsIcon} label="Formula (or type $…$)" onClick={() => c().insertMath().run()} testId="fmt-math" />
        <Btn icon={MinusIcon} label="Divider" onClick={() => c().setHorizontalRule().run()} />
        <Btn
          icon={LinkSimpleIcon}
          label={s.link ? 'Remove link' : `Link (${withMod('click')} opens one)`}
          testId="fmt-link"
          on={s.link || linking !== null}
          onClick={() => (s.link ? c().extendMarkRange('link').unsetLink().run() : setLinking(linking === null ? '' : null))}
        />
      </Group>
      <Group>
        <Btn icon={TextAlignLeftIcon} label="Align left" on={!s.center && !s.right} onClick={() => c().setTextAlign('left').run()} />
        <Btn icon={TextAlignCenterIcon} label="Align center" on={s.center} onClick={() => c().setTextAlign('center').run()} />
        <Btn icon={TextAlignRightIcon} label="Align right" on={s.right} onClick={() => c().setTextAlign('right').run()} />
        <Btn icon={EraserIcon} label="Clear formatting" onClick={() => c().unsetAllMarks().clearNodes().run()} />
      </Group>
      {linking !== null && (
        <form
          className="note-link"
          onSubmit={(e) => {
            e.preventDefault()
            applyLink()
          }}
        >
          <input
            autoFocus
            value={linking}
            onChange={(e) => setLinking(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              // Back to the note, where the cursor was.
              setLinking(null)
              editor.commands.focus()
            }}
            placeholder="Paste a link and press Enter"
            data-testid="note-link-input"
          />
        </form>
      )}
    </div>
  )
}

function Group({ children }: { children: ReactNode }): JSX.Element {
  return <span className="note-tool-group">{children}</span>
}

function Btn({ icon: Glyph, label, on, disabled, onClick, testId }: { icon: PhosphorIcon; label: string; on?: boolean; disabled?: boolean; onClick: () => void; testId?: string }): JSX.Element {
  return (
    <button type="button" className={`note-tool ${on ? 'on' : ''}`} title={label} aria-label={label} aria-pressed={on} disabled={disabled} onClick={onClick} data-testid={testId}>
      <Glyph size={15} />
    </button>
  )
}
