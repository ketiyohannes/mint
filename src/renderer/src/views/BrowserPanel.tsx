import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowSquareOutIcon } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { useApp } from '../state/app'
import { Icon } from '../components/Icon'

const HOME = 'https://www.google.com/'
const PARTITION = 'persist:mint-browser'
/** The page each class's browser was last on ({ classId: url }), so the tab reopens there. */
const PAGES_KEY = 'mint.browser.pages'
const isWeb = (url: string) => /^https?:\/\//i.test(url)

function lastPage(classId: string): string | null {
  try {
    const url = (JSON.parse(localStorage.getItem(PAGES_KEY) ?? '{}') as Record<string, unknown>)[classId]
    return typeof url === 'string' && isWeb(url) ? url : null
  } catch {
    return null
  }
}

function rememberPage(classId: string, url: string): void {
  if (!isWeb(url)) return
  try {
    const pages = JSON.parse(localStorage.getItem(PAGES_KEY) ?? '{}') as Record<string, string>
    localStorage.setItem(PAGES_KEY, JSON.stringify({ ...pages, [classId]: url }))
  } catch {
    // Storage full or unavailable: the tab opens on the home page next time.
  }
}

/** A deleted class takes its last page with it. */
export function forgetBrowserPage(classId: string): void {
  try {
    const { [classId]: _gone, ...pages } = JSON.parse(localStorage.getItem(PAGES_KEY) ?? '{}') as Record<string, string>
    localStorage.setItem(PAGES_KEY, JSON.stringify(pages))
  } catch {
    // Nothing to clean up.
  }
}

/** The last search request acted on. Kept outside the panel, so one that is shown again does not repeat an old search over its page. */
let handledRequest = 0

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

const searchUrl = (query: string) => `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`

/** Turn what was typed into a URL: a web address, or a Google search. */
export function toUrl(input: string): string {
  const t = input.trim()
  if (!t) return HOME
  if (isWeb(t)) return t
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t) && !/\s/.test(t)) return `https://${t}`
  return searchUrl(t)
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
  /** The address box has the keyboard: what is being typed is not replaced by the page's address. */
  const editing = useRef(false)
  const addressRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = document.createElement('webview') as WebviewEl
    view.setAttribute('partition', PARTITION)
    // Links that ask for a new tab reach the main process, which opens them in this one.
    view.setAttribute('allowpopups', '')
    view.setAttribute('src', lastPage(classId) ?? HOME)
    view.className = 'browser-view'
    let remembered = ''
    const sync = () => {
      if (!readyRef.current) return
      try {
        const u = view.getURL()
        setUrl(u)
        if (!editing.current) setAddress(u)
        if (u !== remembered) {
          remembered = u
          rememberPage(classId, u)
        }
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
  }, [classId])

  const load = (target: string) => {
    setAddress(target)
    const view = viewRef.current
    if (!view) return
    if (readyRef.current) void view.loadURL(target).catch(() => undefined)
    else view.setAttribute('src', target)
  }
  const go = (input: string) => load(toUrl(input))

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
  useEffect(() => {
    if (request && request.nonce !== handledRequest) {
      handledRequest = request.nonce
      // Always a search: a selection like "Node.js" or "3.14" looks like an address, but is not one.
      load(searchUrl(request.query))
    }
  }, [request])

  const canAdd = isWeb(url) && !/^https:\/\/www\.google\.[^/]+\/(search|$)/.test(url)

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
            addressRef.current?.blur()
            go(address)
          }}
        >
          <input
            ref={addressRef}
            className="input sm"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              editing.current = true
              e.currentTarget.select()
            }}
            onBlur={() => {
              editing.current = false
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              // Back to the address of the page that is showing.
              setAddress(url)
              e.currentTarget.blur()
            }}
            placeholder="Search Google or type a URL"
            data-testid="browser-address"
          />
        </form>
        <button
          className="icon-btn"
          disabled={!isWeb(url)}
          onClick={() => void run(() => api.system.openExternal(url))}
          title="Open this page in your browser"
          aria-label="Open this page in your browser"
          data-testid="browser-open-external"
        >
          <ArrowSquareOutIcon size={14} />
        </button>
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
