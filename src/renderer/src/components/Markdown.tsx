import { useMemo, type JSX, type MouseEvent } from 'react'
import type { Directive } from '@shared/directives'
import { renderMarkdown } from '../lib/markdown'

interface Props {
  text: string
  className?: string
  streaming?: boolean
  sourceTitle?: (sourceId: string) => string | undefined
  onDirective?: (d: Directive) => void
}

/** Sanitized markdown with clickable citation and diagram chips. */
export function Markdown({ text, className, streaming, sourceTitle, onDirective }: Props): JSX.Element {
  const rendered = useMemo(() => renderMarkdown(text, sourceTitle), [text, sourceTitle])
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-dir]')
    if (!el) return
    const d = rendered.directives[Number(el.dataset.dir)]
    if (d) {
      e.preventDefault()
      onDirective?.(d)
    }
  }
  return (
    <div
      className={`md ${className ?? ''} ${streaming ? 'streaming-caret' : ''}`}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  )
}
