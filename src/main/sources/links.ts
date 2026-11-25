/**
 * Links people share point at a viewer page (a Google Doc in its editor, a
 * paper's abstract, a file on GitHub), and a viewer page has none of the
 * document's text in it. Each kind has an address that serves the document
 * itself; this is where a shared link is turned into that address.
 */
export interface ResolvedLink {
  /** The address to fetch. */
  fetchUrl: string
  /** The link as given: what the source keeps, so "open the original" shows the page the learner knows. */
  pageUrl: string
  /** Set when the document may need sharing before it can be read: what to tell the learner. */
  service?: 'google' | 'dropbox'
}

const GOOGLE_PRIVATE = 'This Google file is not shared by link. In Google, choose Share, then "Anyone with the link", or download the file and add it.'

function googleExport(url: URL): string | null {
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  if (host === 'docs.google.com') {
    // /document/d/<id>/edit, and /document/u/0/d/<id>/edit for a signed-in link.
    const at = parts.indexOf('d')
    const id = at > 0 ? parts[at + 1] : undefined
    if (!id || !/^[\w-]{20,}$/.test(id)) return null
    const base = `https://docs.google.com/${parts[0]}/d/${id}`
    if (parts[0] === 'document') return `${base}/export?format=docx`
    if (parts[0] === 'presentation') return `${base}/export/pdf`
    if (parts[0] === 'spreadsheets') {
      // The sheet that is open, when the link names one.
      const gid = url.searchParams.get('gid') ?? /gid=(\d+)/.exec(url.hash)?.[1]
      return `${base}/export?format=csv${gid && /^\d+$/.test(gid) ? `&gid=${gid}` : ''}`
    }
    return null
  }
  if (host === 'drive.google.com') {
    const id = parts[0] === 'file' && parts[1] === 'd' ? parts[2] : (parts[0] === 'open' || parts[0] === 'uc') && !url.searchParams.has('export') ? url.searchParams.get('id') : null
    return id && /^[\w-]{20,}$/.test(id) ? `https://drive.google.com/uc?export=download&id=${id}` : null
  }
  return null
}

/** The address that serves the document behind a shared link (the link itself when it is already one). */
export function resolveLink(link: string): ResolvedLink {
  const same: ResolvedLink = { fetchUrl: link, pageUrl: link }
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return same
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const parts = url.pathname.split('/').filter(Boolean)

  const google = googleExport(url)
  if (google) return { fetchUrl: google, pageUrl: link, service: 'google' }

  // A paper's abstract page: the paper is the PDF.
  if ((host === 'arxiv.org' || host === 'export.arxiv.org') && parts[0] === 'abs' && parts.length >= 2) {
    return { fetchUrl: `https://arxiv.org/pdf/${parts.slice(1).join('/')}`, pageUrl: link }
  }

  // A file shown on GitHub: the file is on the raw host.
  if (host === 'github.com' && parts[2] === 'blob' && parts.length >= 5) {
    return { fetchUrl: `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`, pageUrl: link }
  }
  if (host === 'gist.github.com' && parts.length === 2 && /^[0-9a-f]{20,}$/i.test(parts[1])) {
    return { fetchUrl: `https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`, pageUrl: link }
  }

  // Dropbox shows a preview unless asked for the file.
  if (host === 'dropbox.com' && url.searchParams.has('dl')) {
    const direct = new URL(url.href)
    direct.searchParams.set('dl', '1')
    return { fetchUrl: direct.href, pageUrl: link, service: 'dropbox' }
  }

  return same
}

/**
 * A document that is not shared answers with a web page (a sign-in form, a
 * warning) instead of the file. Returns what to tell the learner, or null
 * when the answer can be the file.
 */
export function signInWall(resolved: ResolvedLink, looksLikeHtml: boolean): string | null {
  if (!looksLikeHtml) return null
  if (resolved.service === 'google') return GOOGLE_PRIVATE
  if (resolved.service === 'dropbox') return 'This Dropbox file is not shared by link. Share it with "Anyone with the link", or download the file and add it.'
  return null
}

/** The same, for a refusal: a private Google file answers 401 or 403 before any page. */
export function refusalMessage(resolved: ResolvedLink, error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error)
  return resolved.service === 'google' && /HTTP (401|403)\b/.test(text) ? GOOGLE_PRIVATE : null
}
