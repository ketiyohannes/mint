import { useContext, useMemo, type JSX, type MouseEvent } from 'react'
import type { Directive } from '@shared/directives'
import { renderMarkdown } from '../lib/markdown'
import { api } from '../lib/api'
import { StudyCtx } from '../views/study/context'

interface Props {
  text: string
  /** Inline text (titles, option labels): no paragraph wrappers. */
  inline?: boolean
  streaming?: boolean
  className?: string
  /** Override the class-wide directive handling (rarely needed). */
  onDirective?: (d: Directive) => void
  testId?: string
}

/**
 * The one way mint shows tutor-written text: markdown, LaTeX, ```array cells,
 * code, and clickable citation / tool / diagram chips. Inside a class it wires
 * citations and tool offers to the workspace automatically, so every surface
 * (chat, side chats, lesson brief and checks, quizzes, plans, sources lists)
 * behaves the same.
 */
export function RichText({ text, inline, streaming, className, onDirective, testId }: Props): JSX.Element {
  const study = useContext(StudyCtx)
  const sourceTitle = study?.sourceTitle
  const rendered = useMemo(() => renderMarkdown(text, sourceTitle, { inline }), [text, sourceTitle, inline])
  const handle = onDirective ?? study?.handleDirective

  const onClick = (e: MouseEvent<HTMLElement>) => {
    // Links open in the system browser; the app window never navigates away.
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
    if (link) {
      e.preventDefault()
      e.stopPropagation()
      if (/^https?:\/\//i.test(link.href)) void api.system.openExternal(link.href)
      return
    }
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-dir]')
    const d = el ? rendered.directives[Number(el.dataset.dir)] : undefined
    if (d && handle) {
      e.preventDefault()
      e.stopPropagation()
      handle(d)
    }
  }

  const classes = `md ${inline ? 'inline' : ''} ${className ?? ''} ${streaming ? 'streaming-caret' : ''}`
  return inline ? (
    <span className={classes} onClick={onClick} dangerouslySetInnerHTML={{ __html: rendered.html }} data-testid={testId} />
  ) : (
    <div className={classes} onClick={onClick} dangerouslySetInnerHTML={{ __html: rendered.html }} data-testid={testId} />
  )
}
