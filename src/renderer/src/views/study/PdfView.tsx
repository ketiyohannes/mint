import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Annotation, SourceDoc, SourceSection, Thread } from '@shared/types'
import { quoteToRanges, rangeForQuote, type SelectionAnchor } from '../../lib/anchors'
import { api, errorMessage } from '../../lib/api'
import type { ReaderFocus } from './Reader'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

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
  /** The original file is not available: the caller shows the text view instead. */
  onUnavailable: () => void
}

interface Pin {
  page: number
  top: number
  kind: 'q' | 'n'
  id: string
}

const HIGHLIGHTS = ['mint-hl', 'mint-note', 'mint-thread', 'mint-flash'] as const
const MAX_WIDTH = 980

/** Bytes of recently opened PDFs (switching tabs should not refetch). */
const bytesCache = new Map<string, Uint8Array>()

function pageOf(label: string | undefined): number | null {
  const m = /(\d+)/.exec(label ?? '')
  return m ? Number(m[1]) : null
}

/**
 * The original PDF, page by page (pdf.js canvas + selectable text layer).
 * Selections map back to the normalized text's block ranges, so Ask, notes,
 * highlights and citations work exactly as in the text view.
 */
export const PdfView = memo(function PdfView(props: Props): JSX.Element {
  const { doc, annotations, threads, focus, hidePins, openThreadId, onSelection, onOpenThread, onOpenNote, onUnavailable } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [width, setWidth] = useState(0)
  const [ratio, setRatio] = useState(1.294) // height / width of page 1 (A4/Letter-ish until known)
  const [ready, setReady] = useState<Set<number>>(new Set())
  const [pins, setPins] = useState<Pin[]>([])
  const [flash, setFlash] = useState<{ page: number; quote?: string; nonce: number } | null>(null)
  const textRoots = useRef(new Map<number, HTMLElement>())
  const pageEls = useRef(new Map<number, HTMLElement>())

  // Load the document.
  useEffect(() => {
    let alive = true
    let loaded: PDFDocumentProxy | null = null
    const key = `${doc.classId}/${doc.id}`
    void (async () => {
      try {
        let bytes = bytesCache.get(key)
        if (!bytes) {
          const fetched = await api.sources.original(doc.classId, doc.id)
          if (!fetched) {
            if (alive) onUnavailable()
            return
          }
          bytes = fetched
          bytesCache.set(key, bytes)
          while (bytesCache.size > 4) bytesCache.delete(bytesCache.keys().next().value!)
        }
        // pdf.js transfers the buffer to its worker; give it a copy so the cache stays intact.
        const task = pdfjs.getDocument({ data: bytes.slice() })
        loaded = await task.promise
        if (!alive) return void loaded.destroy()
        const first = await loaded.getPage(1)
        const vp = first.getViewport({ scale: 1 })
        if (!alive) return
        setRatio(vp.height / vp.width)
        setPdf(loaded)
      } catch (err) {
        if (alive) setError(errorMessage(err))
      }
    })()
    return () => {
      alive = false
      void loaded?.destroy()
      for (const name of HIGHLIGHTS) CSS.highlights?.delete(name)
    }
  }, [doc.classId, doc.id, onUnavailable])

  // Fit pages to the column width.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = () => setWidth(Math.min(MAX_WIDTH, Math.max(240, el.clientWidth - 84)))
    measure()
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(measure, 120)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      clearTimeout(timer)
    }
  }, [])

  const sectionByPage = useMemo(() => {
    const map = new Map<number, SourceSection>()
    for (const s of doc.sections) {
      const n = pageOf(s.label)
      if (n !== null && !map.has(n)) map.set(n, s)
    }
    return map
  }, [doc.sections])

  const onTextReady = useCallback((page: number, root: HTMLElement | null) => {
    if (root) textRoots.current.set(page, root)
    else textRoots.current.delete(page)
    setReady((r) => {
      const has = r.has(page)
      if (Boolean(root) === has) return r
      const next = new Set(r)
      if (root) next.add(page)
      else next.delete(page)
      return next
    })
  }, [])

  // Paint highlights, Ask threads, notes and the citation flash with the CSS Highlight API, and place pins.
  useEffect(() => {
    if (!CSS.highlights) return
    const sets: Record<(typeof HIGHLIGHTS)[number], Range[]> = { 'mint-hl': [], 'mint-note': [], 'mint-thread': [], 'mint-flash': [] }
    const nextPins: Pin[] = []
    const place = (page: number, range: Range, kind: Pin['kind'], id: string) => {
      const pageEl = pageEls.current.get(page)
      const r = range.getClientRects()[0]
      if (!pageEl || !r) return
      nextPins.push({ page, top: r.top - pageEl.getBoundingClientRect().top, kind, id })
    }
    for (const a of annotations) {
      if (a.anchor.sourceId !== doc.id) continue
      const page = pageOf(a.anchor.sectionLabel)
      const root = page !== null ? textRoots.current.get(page) : undefined
      const range = root ? rangeForQuote(root, a.anchor.quote) : null
      if (!range || page === null) continue
      sets[a.kind === 'note' ? 'mint-note' : 'mint-hl'].push(range)
      if (a.kind === 'note') place(page, range, 'n', a.id)
    }
    for (const t of threads) {
      if (t.anchor.kind !== 'source' || t.anchor.sourceId !== doc.id) continue
      const page = pageOf(t.anchor.sectionLabel)
      const root = page !== null ? textRoots.current.get(page) : undefined
      const range = root ? rangeForQuote(root, t.anchor.quote) : null
      if (!range || page === null) continue
      sets['mint-thread'].push(range)
      if (t.pinned || t.id === openThreadId) place(page, range, 'q', t.id)
    }
    if (flash?.quote) {
      const root = textRoots.current.get(flash.page)
      const range = root ? rangeForQuote(root, flash.quote) : null
      if (range) sets['mint-flash'].push(range)
    }
    for (const name of HIGHLIGHTS) CSS.highlights.set(name, new Highlight(...sets[name]))
    setPins(nextPins)
  }, [annotations, threads, doc.id, ready, width, flash, openThreadId])

  // Jump to a cited page (and quote).
  useEffect(() => {
    if (!focus || !pdf) return
    let page = pageOf(focus.section)
    if (page === null && focus.quote) {
      for (const [n, s] of sectionByPage) {
        if (quoteToRanges(s.blocks, focus.quote).length) {
          page = n
          break
        }
      }
    }
    if (page === null || page < 1 || page > pdf.numPages) return
    setFlash({ page, quote: focus.quote, nonce: focus.nonce })
    // Scroll only the page column (scrollIntoView would also scroll the app shell).
    const pageEl = pageEls.current.get(page)
    if (pageEl && scrollRef.current) scrollRef.current.scrollTo({ top: pageEl.offsetTop - 12 })
    const t = setTimeout(() => setFlash(null), 2800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, pdf])

  // Once the cited page's text is ready, center the quote.
  useEffect(() => {
    if (!flash?.quote || !ready.has(flash.page)) return
    const root = textRoots.current.get(flash.page)
    const range = root ? rangeForQuote(root, flash.quote) : null
    const box = range?.getBoundingClientRect()
    const scroller = scrollRef.current
    if (box && scroller) {
      const s = scroller.getBoundingClientRect()
      scroller.scrollBy({ top: box.top - s.top - s.height / 3, behavior: 'smooth' })
    }
  }, [flash, ready])

  function handleMouseUp() {
    setTimeout(() => {
      const root = scrollRef.current
      const sel = window.getSelection()
      if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return onSelection(null)
      const range = sel.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) return onSelection(null)
      const pageEl = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest<HTMLElement>('[data-page]')
      const endEl = (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement)?.closest<HTMLElement>('[data-page]')
      const quote = sel.toString().replace(/\s+/g, ' ').trim()
      if (!pageEl || !quote) return onSelection(null)
      const from = Number(pageEl.dataset.page)
      const to = Math.max(from, Number(endEl?.dataset.page ?? from))
      const sections = [...Array(to - from + 1)].map((_, i) => sectionByPage.get(from + i)).filter((s): s is SourceSection => Boolean(s))
      const section = sections[0]
      if (!section) return onSelection(null)
      let ranges = quoteToRanges(
        sections.flatMap((s) => s.blocks),
        quote
      )
      // Text extraction can differ from the rendered glyphs (ligatures, hyphenation):
      // fall back to the first block of the page so the question still has its context.
      if (!ranges.length && section.blocks[0]) ranges = [{ blockId: section.blocks[0].id, start: 0, end: section.blocks[0].text.length }]
      if (!ranges.length) return onSelection(null)
      onSelection({ ranges, quote: quote.slice(0, 2000), rect: range.getBoundingClientRect(), sectionLabel: section.label })
    }, 0)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => onSelection(null)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [onSelection])

  const openPin = (pin: Pin, rect: DOMRect) => {
    if (pin.kind === 'q') {
      const t = threads.find((x) => x.id === pin.id)
      if (t) onOpenThread(t, rect)
    } else {
      const a = annotations.find((x) => x.id === pin.id)
      if (a) onOpenNote(a, rect)
    }
  }

  return (
    <div className="pdf-scroll" ref={scrollRef} onMouseUp={handleMouseUp} data-testid="pdf-view">
      {error ? (
        <div className="empty">
          <p>This PDF could not be displayed: {error}</p>
          <button className="btn" onClick={onUnavailable}>
            Show as text
          </button>
        </div>
      ) : !pdf || !width ? (
        <div className="empty">
          <span className="spinner" />
        </div>
      ) : (
        [...Array(pdf.numPages)].map((_, i) => (
          <PdfPage
            key={i + 1}
            pdf={pdf}
            n={i + 1}
            width={width}
            ratio={ratio}
            scrollRoot={scrollRef}
            onTextReady={onTextReady}
            register={(el) => (el ? pageEls.current.set(i + 1, el) : pageEls.current.delete(i + 1))}
            pins={hidePins ? [] : pins.filter((p) => p.page === i + 1)}
            onPin={openPin}
          />
        ))
      )}
    </div>
  )
})

interface PageProps {
  pdf: PDFDocumentProxy
  n: number
  width: number
  ratio: number
  scrollRoot: React.RefObject<HTMLDivElement | null>
  onTextReady: (page: number, root: HTMLElement | null) => void
  register: (el: HTMLElement | null) => void
  pins: Pin[]
  onPin: (pin: Pin, rect: DOMRect) => void
}

/** One page: rendered when near the viewport, re-rendered when the width changes. */
const PdfPage = memo(function PdfPage({ pdf, n, width, ratio, scrollRoot, onTextReady, register, pins, onPin }: PageProps): JSX.Element {
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [height, setHeight] = useState(Math.round(width * ratio))
  const registerRef = useRef(register)
  registerRef.current = register

  useEffect(() => {
    registerRef.current(pageRef.current)
    return () => registerRef.current(null)
  }, [])

  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { root: scrollRoot.current, rootMargin: '1200px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [scrollRoot])

  useEffect(() => {
    if (!near) return
    let cancelled = false
    let task: RenderTask | null = null
    let textLayer: pdfjs.TextLayer | null = null
    void (async () => {
      try {
        const page = await pdf.getPage(n)
        if (cancelled) return
        const scale = width / page.getViewport({ scale: 1 }).width
        const viewport = page.getViewport({ scale })
        setHeight(Math.round(viewport.height))
        pageRef.current?.style.setProperty('--total-scale-factor', String(scale))
        const canvas = canvasRef.current
        const textDiv = textRef.current
        if (!canvas || !textDiv) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
        await task.promise
        if (cancelled) return
        onTextReady(n, null)
        textDiv.replaceChildren()
        textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport })
        await textLayer.render()
        if (!cancelled) onTextReady(n, textDiv)
      } catch (err) {
        if (!cancelled && !(err instanceof Error && err.name === 'RenderingCancelledException')) console.warn(`mint: page ${n} failed to render`, err)
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
      textLayer?.cancel()
    }
  }, [near, pdf, n, width, onTextReady])

  useEffect(() => () => onTextReady(n, null), [n, onTextReady])

  return (
    <div className="pdf-page" ref={pageRef} data-page={n} style={{ width, height }}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="textLayer" ref={textRef} />
      <span className="pdf-page-num" aria-hidden="true">
        {n}
      </span>
      {pins.map((p) => (
        <button
          key={p.id}
          className={`pin ${p.kind} pdf-pin`}
          style={{ top: p.top }}
          title={p.kind === 'q' ? 'Open this Ask thread' : 'Open this note'}
          aria-label={p.kind === 'q' ? 'Open Ask thread' : 'Open note'}
          data-testid={p.kind === 'q' ? 'pin-thread' : 'pin-note'}
          onClick={(e) => onPin(p, e.currentTarget.getBoundingClientRect())}
        >
          {p.kind === 'q' ? '?' : '✎'}
        </button>
      ))}
    </div>
  )
})
