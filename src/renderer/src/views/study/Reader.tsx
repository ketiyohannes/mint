import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Annotation, SourceBlock, SourceDoc, Thread } from '@shared/types'
import { findQuote, segmentText, selectionToAnchor, type Mark, type SelectionAnchor } from '../../lib/anchors'
import { api } from '../../lib/api'
import { useApp } from '../../state/app'
import { isFreshJump, positionKey, readingPosition, rememberPosition, takeJump } from './position'

export interface ReaderFocus {
  section?: string
  quote?: string
  nonce: number
}

interface Props {
  doc: SourceDoc
  annotations: Annotation[]
  threads: Thread[]
  focus: ReaderFocus | null
  hidePins: boolean
  openThreadId: string | null
  onSelection: (anchor: SelectionAnchor | null) => void
  onOpenThread: (thread: Thread, rect: DOMRect) => void
  onOpenNote: (annotation: Annotation, rect: DOMRect) => void
}

const fmt = (t: number) => {
  const s = Math.max(0, Math.floor(t))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function normLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(page|pp?\.?)\s*/, 'p ')
    .replace(/[^a-z0-9:]+/g, ' ')
    .trim()
}

/** The interactive reader: highlights, Ask threads and sticky notes live in the margin. */
export const Reader = memo(function Reader(props: Props): JSX.Element {
  const { doc, annotations, threads, focus, hidePins, openThreadId, onSelection, onOpenThread, onOpenNote } = props
  const { run } = useApp()
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<HTMLIFrameElement>(null)
  const [flash, setFlash] = useState<{ blockId: string; start: number; end: number } | null>(null)
  const [transcript, setTranscript] = useState('')

  const blockIndex = useMemo(() => {
    const map = new Map<string, SourceBlock>()
    for (const s of doc.sections) for (const b of s.blocks) map.set(b.id, b)
    return map
  }, [doc])

  // Marks and pins per block.
  const { marksByBlock, pinsByBlock } = useMemo(() => {
    const marks = new Map<string, Mark[]>()
    const pins = new Map<string, { kind: 'q' | 'n'; id: string }[]>()
    const add = (blockId: string, m: Mark) => marks.set(blockId, [...(marks.get(blockId) ?? []), m])
    for (const a of annotations) {
      if (a.anchor.sourceId !== doc.id) continue
      for (const r of a.anchor.ranges) add(r.blockId, { start: r.start, end: r.end, kind: a.kind, id: a.id })
      if (a.kind === 'note') {
        const first = a.anchor.ranges[0]?.blockId
        if (first) pins.set(first, [...(pins.get(first) ?? []), { kind: 'n', id: a.id }])
      }
    }
    for (const t of threads) {
      if (t.anchor.kind !== 'source' || t.anchor.sourceId !== doc.id) continue
      for (const r of t.anchor.ranges) add(r.blockId, { start: r.start, end: r.end, kind: 'thread', id: t.id })
      if (t.pinned || t.id === openThreadId) {
        const first = t.anchor.ranges[0]?.blockId
        if (first) pins.set(first, [...(pins.get(first) ?? []), { kind: 'q', id: t.id }])
      }
    }
    if (flash) add(flash.blockId, { start: flash.start, end: flash.end, kind: 'flash-quote', id: 'flash' })
    return { marksByBlock: marks, pinsByBlock: pins }
  }, [annotations, threads, doc.id, flash, openThreadId])

  // Open where the learner left this source, unless a citation is about to jump somewhere.
  const posKey = positionKey(doc.classId, doc.id, 'text')
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const saved = readingPosition(posKey)
    if (!scroller || !saved || !('block' in saved) || (focus && isFreshJump(focus.nonce))) return
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(saved.block)}"]`)
    if (el) scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Jump to a section / quote when asked (citations, brief readings, path links).
  const jumped = useRef(0)
  useEffect(() => {
    if (!focus) return
    const root = containerRef.current
    if (!root) return
    // Once per request: the host hands the last one to every source it shows next.
    if (!takeJump(focus.nonce, jumped)) return
    let section = focus.section ? doc.sections.find((s) => s.label === focus.section) : undefined
    if (!section && focus.section) {
      const want = normLabel(focus.section)
      section = doc.sections.find((s) => normLabel(s.label) === want) ?? doc.sections.find((s) => normLabel(s.label).includes(want) || want.includes(normLabel(s.label)))
    }
    const pool = (section ? [section] : doc.sections).flatMap((s) => s.blocks)
    const hit = focus.quote
      ? (findQuote(pool, focus.quote) ??
        (section
          ? findQuote(
              doc.sections.flatMap((s) => s.blocks),
              focus.quote
            )
          : null))
      : null
    const targetId = hit?.blockId ?? section?.blocks[0]?.id
    const el = targetId ? root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(targetId)}"]`) : section ? root.querySelector<HTMLElement>(`[data-section-id="${section.id}"]`) : null
    if (!el) return
    // Wait one frame so a freshly mounted document has laid out.
    requestAnimationFrame(() => {
      // Scroll only the reader (scrollIntoView would also scroll the app shell).
      const scroller = scrollRef.current
      if (scroller) {
        const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        scroller.scrollTo({ top: top - scroller.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' })
      }
      el.classList.remove('flash')
      void el.offsetWidth
      el.classList.add('flash')
    })
    // A cited moment of a video plays from there, whether or not its words were found.
    const block = blockIndex.get(targetId ?? '')
    if (block?.t !== undefined) seek(block.t)
    if (hit) {
      setFlash(hit)
      const t = setTimeout(() => setFlash(null), 2600)
      return () => clearTimeout(t)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, doc.id])

  const seek = useCallback((t: number) => {
    playerRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [t, true] }), '*')
    playerRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), '*')
  }, [])

  const onPin = useCallback(
    (pin: { kind: 'q' | 'n'; id: string }, rect: DOMRect) => {
      if (pin.kind === 'q') {
        const t = threads.find((x) => x.id === pin.id)
        if (t) onOpenThread(t, rect)
      } else {
        const a = annotations.find((x) => x.id === pin.id)
        if (a) onOpenNote(a, rect)
      }
    },
    [threads, annotations, onOpenThread, onOpenNote]
  )

  // The selection is read on any mouse release (a drag often ends outside the text), and a release
  // that leaves nothing selected here (a click elsewhere, another tab) takes the toolbar away.
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      // A press on the selection's own toolbar, or in a popover, is not a new selection.
      if (e.target instanceof Element && e.target.closest('.sel-toolbar, .popover')) return
      // Let the browser finalize the selection first.
      setTimeout(() => {
        const root = containerRef.current
        // Text still selected in a tab that is no longer showing has no toolbar either.
        if (root) onSelection(root.closest('.panel-page.inactive') ? null : selectionToAnchor(root, (id) => blockIndex.get(id)?.text))
      }, 0)
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [onSelection, blockIndex])

  // Leaving (another source, the page view) takes the toolbar along.
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  useEffect(() => () => onSelectionRef.current(null), [])

  // Scrolling puts the toolbar away, and remembers the block at the top of the view.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    let blocks: HTMLElement[] | null = null
    const remember = () => {
      frame = 0
      blocks ??= Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [])
      if (!blocks.length) return
      const top = el.getBoundingClientRect().top
      let lo = 0
      let hi = blocks.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (blocks[mid].getBoundingClientRect().bottom > top) hi = mid
        else lo = mid + 1
      }
      rememberPosition(posKey, { block: blocks[lo].dataset.blockId!, offset: Math.round(blocks[lo].getBoundingClientRect().top - top) })
    }
    const onScroll = () => {
      onSelection(null)
      if (!frame) frame = requestAnimationFrame(remember)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [onSelection, posKey, doc.sections])

  return (
    <div className={`reader ${hidePins ? 'reader-hidden-pins' : ''}`} ref={scrollRef} data-testid="reader">
      <div className="reader-doc" ref={containerRef}>
        <h1 className="reader-title">{doc.title}</h1>
        <div className="small muted" style={{ marginBottom: 18 }}>
          {doc.author ? `${doc.author} · ` : ''}
          {doc.origin === 'user' ? 'Your material' : `Found by mint${doc.domain ? ` · ${doc.domain}` : ''}`}
          {doc.url && (
            <>
              {' · '}
              <a
                href={doc.url}
                onClick={(e) => {
                  e.preventDefault()
                  void api.system.openExternal(doc.url!)
                }}
              >
                Open original
              </a>
            </>
          )}
        </div>

        {doc.kind === 'youtube' && doc.videoId && (
          <iframe
            ref={playerRef}
            className="video-frame"
            title={doc.title}
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(doc.videoId)}?enablejsapi=1&rel=0&modestbranding=1`}
            allow="encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation"
          />
        )}

        {doc.needsTranscript && (
          <div className="card soft">
            <div className="card-title">This video has no transcript yet</div>
            <p className="small muted" style={{ marginTop: -6 }}>
              Paste one (from YouTube's "Show transcript", or your own notes with timestamps) so you can highlight and ask about it.
            </p>
            <textarea className="textarea" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={'0:00 Welcome to the lecture…\n0:42 Today we cover…'} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary sm" disabled={!transcript.trim()} onClick={() => void run(() => api.sources.setTranscript(doc.classId, doc.id, transcript), 'Transcript added.')}>
                Save transcript
              </button>
            </div>
          </div>
        )}

        {doc.sections.map((section) => (
          <section key={section.id} className="reader-section" data-section-id={section.id} data-section-label={section.label}>
            <div className="section-label">
              {section.t !== undefined ? (
                <button className="cue-time" data-ignore-text onClick={() => seek(section.t!)}>
                  ▶ {section.label}
                </button>
              ) : (
                section.label
              )}
            </div>
            {section.blocks.map((b) => (
              <Block key={b.id} block={b} marks={marksByBlock.get(b.id)} pins={pinsByBlock.get(b.id)} onSeek={seek} onPin={onPin} />
            ))}
          </section>
        ))}
      </div>
    </div>
  )
})

interface BlockProps {
  block: SourceBlock
  marks?: Mark[]
  pins?: { kind: 'q' | 'n'; id: string }[]
  onSeek: (t: number) => void
  onPin: (pin: { kind: 'q' | 'n'; id: string }, rect: DOMRect) => void
}

/** Block CSS classes (prefixed so they never collide with component classes like .list-item). */
const BLOCK_CLASS: Record<SourceBlock['type'], string> = {
  heading: 'b-heading',
  paragraph: 'b-paragraph',
  'list-item': 'b-li',
  quote: 'b-quote',
  code: 'b-code',
  cue: 'b-cue'
}

const Block = memo(function Block({ block, marks, pins, onSeek, onPin }: BlockProps): JSX.Element {
  const segments = marks?.length ? segmentText(block.text, marks) : [{ text: block.text, marks: [] }]
  const content = segments.map((seg, i) => {
    if (!seg.marks.length) return <span key={i}>{seg.text}</span>
    const kinds = new Set(seg.marks.map((m) => m.kind))
    const cls = kinds.has('flash-quote') ? 'flash-quote' : kinds.has('note') ? 'note' : kinds.has('highlight') ? '' : 'thread'
    return (
      <mark key={i} className={`hl ${cls}`}>
        {seg.text}
      </mark>
    )
  })
  const level = block.level ? `h${Math.min(block.level, 3)}` : ''
  return (
    <div className={`block ${BLOCK_CLASS[block.type]} ${level}`} data-block-id={block.id}>
      {block.type === 'cue' ? (
        <>
          <button className="cue-time" data-ignore-text onClick={() => block.t !== undefined && onSeek(block.t)}>
            {block.t !== undefined ? fmt(block.t) : ''}
          </button>
          <span>{content}</span>
        </>
      ) : (
        content
      )}
      {pins && pins.length > 0 && (
        <span className="gutter" data-ignore-text>
          {pins.map((p) => (
            <button
              key={p.id}
              className={`pin ${p.kind}`}
              title={p.kind === 'q' ? 'Open this Ask thread' : 'Open this note'}
              aria-label={p.kind === 'q' ? 'Open Ask thread' : 'Open note'}
              data-testid={p.kind === 'q' ? 'pin-thread' : 'pin-note'}
              onClick={(e) => onPin(p, (e.currentTarget as HTMLElement).getBoundingClientRect())}
            >
              {p.kind === 'q' ? '?' : '✎'}
            </button>
          ))}
        </span>
      )}
    </div>
  )
})
