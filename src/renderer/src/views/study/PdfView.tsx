import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Annotation, SourceDoc, SourceSection, Thread } from '@shared/types'
import { quoteToRanges, rangeForQuote, type SelectionAnchor } from '../../lib/anchors'
import { api, errorMessage } from '../../lib/api'
import { Icon } from '../../components/Icon'
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
  /** Show the pages dark (light text on a dark page). */
  dark?: boolean
}

interface Pin {
  page: number
  top: number
  kind: 'q' | 'n'
  id: string
}

const HIGHLIGHTS = ['mint-hl', 'mint-note', 'mint-thread', 'mint-flash'] as const
const MAX_WIDTH = 980
/** Zoom is relative to fitting the page to the column (1 = fit width). */
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3]
const MIN_ZOOM = ZOOM_STEPS[0]
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]
/** Re-render page canvases this long after the zoom settles (pinching stretches them meanwhile). */
const RENDER_SETTLE_MS = 140
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

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
  const { doc, annotations, threads, focus, hidePins, openThreadId, onSelection, onOpenThread, onOpenNote, onUnavailable, dark } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fitWidth, setFitWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const width = Math.round(fitWidth * zoom)
  /** The point to keep still while zooming: a fraction of the content, and where it sat in the view. */
  const zoomAnchor = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null)
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
    const measure = () => setFitWidth(Math.min(MAX_WIDTH, Math.max(240, el.clientWidth - 84)))
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

  /** Zoom to `next`, keeping the content under `at` (a screen point; default the view's center) in place. */
  const zoomTo = useCallback((next: number, at?: { x: number; y: number }) => {
    const el = scrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const px = at ? at.x - rect.left : el.clientWidth / 2
    const py = at ? at.y - rect.top : el.clientHeight / 2
    zoomAnchor.current = { fx: (el.scrollLeft + px) / el.scrollWidth, fy: (el.scrollTop + py) / el.scrollHeight, px, py }
    setZoom(clampZoom(next))
  }, [])
  const zoomStep = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001)
    zoomTo(next ?? zoom)
  }

  // Page sizes follow the width in the same render, so the anchor can be restored before paint.
  useLayoutEffect(() => {
    const a = zoomAnchor.current
    const el = scrollRef.current
    if (!a || !el) return
    zoomAnchor.current = null
    el.scrollLeft = a.fx * el.scrollWidth - a.px
    el.scrollTop = a.fy * el.scrollHeight - a.py
  }, [width])

  // Pinch on a trackpad (or Ctrl/⌘ + scroll) zooms the pages, not the app.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo, pdf])

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
    <div className="pdf-frame">
    <div className={`pdf-scroll ${dark ? 'dark' : ''}`} ref={scrollRef} onMouseUp={handleMouseUp} data-testid="pdf-view">
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
        <div className="pdf-pages">
        {[...Array(pdf.numPages)].map((_, i) => (
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
        ))}
        </div>
      )}
    </div>
      {pdf && !error && (
        <div className="pdf-zoom" role="group" aria-label="Zoom">
          <button className="icon-btn" onClick={() => zoomStep(-1)} disabled={zoom <= MIN_ZOOM + 0.001} title="Zoom out" aria-label="Zoom out" data-testid="pdf-zoom-out">
            <Icon name="minus" size={13} />
          </button>
          <button className="pdf-zoom-level" onClick={() => zoomTo(1)} title="Fit to width" data-testid="pdf-zoom-level">
            {Math.round(zoom * 100)}%
          </button>
          <button className="icon-btn" onClick={() => zoomStep(1)} disabled={zoom >= MAX_ZOOM - 0.001} title="Zoom in" aria-label="Zoom in" data-testid="pdf-zoom-in">
            <Icon name="plus" size={13} />
          </button>
        </div>
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

/** One page: rendered when near the viewport; the canvas is redrawn when the width settles. */
const PdfPage = memo(function PdfPage({ pdf, n, width, ratio, scrollRoot, onTextReady, register, pins, onPin }: PageProps): JSX.Element {
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  // Height follows the width at once (the page's own ratio once known), so zooming lays out in one pass.
  const [pageRatio, setPageRatio] = useState(ratio)
  const height = Math.round(width * pageRatio)
  const baseWidth = useRef<number | null>(null)
  const widthRef = useRef(width)
  widthRef.current = width
  // The canvas re-renders once the width settles; until then it is stretched to the new size.
  const [renderWidth, setRenderWidth] = useState(width)
  useEffect(() => {
    if (renderWidth === width) return
    const t = setTimeout(() => setRenderWidth(width), RENDER_SETTLE_MS)
    return () => clearTimeout(t)
  }, [width, renderWidth])
  // Keep the selectable text aligned with the stretched canvas meanwhile.
  useLayoutEffect(() => {
    if (baseWidth.current) pageRef.current?.style.setProperty('--total-scale-factor', String(width / baseWidth.current))
  }, [width])
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

  // The canvas: drawn at the settled width (sharp at any zoom).
  useEffect(() => {
    if (!near) return
    let cancelled = false
    let task: RenderTask | null = null
    void (async () => {
      try {
        const page = await pdf.getPage(n)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        baseWidth.current = base.width
        setPageRatio(base.height / base.width)
        // The width may have moved on while this page loaded (pinching): scale the text to the latest one.
        pageRef.current?.style.setProperty('--total-scale-factor', String(widthRef.current / base.width))
        const viewport = page.getViewport({ scale: renderWidth / base.width })
        const canvas = canvasRef.current
        if (!canvas) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
        await task.promise
      } catch (err) {
        if (!cancelled && !(err instanceof Error && err.name === 'RenderingCancelledException')) console.warn(`mint: page ${n} failed to render`, err)
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [near, pdf, n, renderWidth])

  // The selectable text: built once per page and sized by --total-scale-factor, so a
  // selection (and highlights) survive zooming and resizing.
  useEffect(() => {
    if (!near) return
    let cancelled = false
    let textLayer: pdfjs.TextLayer | null = null
    void (async () => {
      try {
        const page = await pdf.getPage(n)
        const textDiv = textRef.current
        if (cancelled || !textDiv) return
        const viewport = page.getViewport({ scale: 1 })
        baseWidth.current = viewport.width
        pageRef.current?.style.setProperty('--total-scale-factor', String(widthRef.current / viewport.width))
        textDiv.replaceChildren()
        textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport })
        await textLayer.render()
        if (!cancelled) onTextReady(n, textDiv)
      } catch (err) {
        if (!cancelled) console.warn(`mint: page ${n} text failed to load`, err)
      }
    })()
    return () => {
      cancelled = true
      textLayer?.cancel()
      onTextReady(n, null)
    }
  }, [near, pdf, n, onTextReady])

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
