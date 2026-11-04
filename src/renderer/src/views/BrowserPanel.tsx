import { useEffect, useRef, useState, type JSX } from 'react'
import { api } from '../lib/api'
import { useApp } from '../state/app'
import { Icon } from '../components/Icon'

const HOME = 'https://www.google.com/'
const PARTITION = 'persist:mint-browser'

/** The subset of Electron's <webview> element this panel uses. */
interface WebviewEl extends HTMLElement {
  src: string
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): Promise<void>
}

/** Turn what was typed into a URL: a web address, or a Google search. */
export function toUrl(input: string): string {
  const t = input.trim()
  if (!t) return HOME
  if (/^https?:\/\//i.test(t)) return t
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t) && !/\s/.test(t)) return `https://${t}`
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}

/**
 * A small web browser for independent research: search, read, and add a good
 * page to the class as a source. Runs in an isolated, sandboxed <webview>.
 */
export function BrowserPanel({ classId, request }: { classId: string; request: { query: string; nonce: number } | null }): JSX.Element {
  const { run, toast } = useApp()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<WebviewEl | null>(null)
  /** Webview methods throw until the guest has attached and fired dom-ready. */
  const readyRef = useRef(false)
  const [address, setAddress] = useState('')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = document.createElement('webview') as WebviewEl
    view.setAttribute('partition', PARTITION)
    view.setAttribute('src', HOME)
    view.className = 'browser-view'
    const sync = () => {
      if (!readyRef.current) return
      try {
        const u = view.getURL()
        setUrl(u)
        setAddress(u)
        setTitle(view.getTitle())
        setNav({ back: view.canGoBack(), forward: view.canGoForward() })
      } catch {
        // Not attached yet.
      }
    }
    const onReady = () => {
      readyRef.current = true
      sync()
    }
    const onStart = () => setLoading(true)
    const onStop = () => {
      setLoading(false)
      sync()
    }
    view.addEventListener('dom-ready', onReady)
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', sync)
    view.addEventListener('did-navigate-in-page', sync)
    view.addEventListener('page-title-updated', sync)
    host.appendChild(view)
    viewRef.current = view
    return () => {
      readyRef.current = false
      view.remove()
      viewRef.current = null
    }
  }, [])

  const go = (input: string) => {
    const target = toUrl(input)
    setAddress(target)
    const view = viewRef.current
    if (!view) return
    if (readyRef.current) void view.loadURL(target).catch(() => undefined)
    else view.setAttribute('src', target)
  }

  /** Call a webview method only once it can take it. */
  const call = (fn: (v: WebviewEl) => void) => {
    const v = viewRef.current
    if (!v || !readyRef.current) return
    try {
      fn(v)
    } catch {
      // The guest went away (navigation crash); the next load recovers.
    }
  }

  // "Search the web" requests from elsewhere (e.g. a selection in the reader).
  const lastRequest = useRef(0)
  useEffect(() => {
    if (request && request.nonce !== lastRequest.current) {
      lastRequest.current = request.nonce
      go(request.query)
    }
  }, [request])

  const canAdd = /^https?:\/\//i.test(url) && !/^https:\/\/www\.google\.[^/]+\/(search|$)/.test(url)

  return (
    <div className="browser" data-testid="browser">
      <div className="browser-bar">
        <button className="icon-btn" disabled={!nav.back} onClick={() => call((v) => v.goBack())} aria-label="Back">
          <Icon name="back" size={14} />
        </button>
        <button className="icon-btn" disabled={!nav.forward} onClick={() => call((v) => v.goForward())} aria-label="Forward">
          <Icon name="arrow" size={14} />
        </button>
        <button className="icon-btn" onClick={() => call((v) => (loading ? v.stop() : v.reload()))} aria-label={loading ? 'Stop' : 'Reload'}>
          <Icon name={loading ? 'x' : 'refresh'} size={13} />
        </button>
        <form
          className="browser-address"
          onSubmit={(e) => {
            e.preventDefault()
            go(address)
          }}
        >
          <input className="input sm" value={address} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => e.currentTarget.select()} placeholder="Search Google or type a URL" data-testid="browser-address" />
        </form>
        <button
          className="btn sm"
          disabled={!canAdd || adding}
          title={canAdd ? `Add "${title || url}" to this class` : 'Open a page to add it'}
          onClick={async () => {
            setAdding(true)
            const s = await run(() => api.sources.addUrl(classId, url))
            setAdding(false)
            if (s) toast(`Added "${s.title}" to your sources.`)
          }}
          data-testid="browser-add"
        >
          {adding ? <span className="spinner tiny" /> : <Icon name="plus" size={12} />} Add to class
        </button>
      </div>
      <div className="browser-host" ref={hostRef} />
    </div>
  )
}
