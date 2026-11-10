import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { FetchOptions } from './types'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export interface FetchedResource {
  finalUrl: string
  /** Raw Content-Type header value (may include parameters such as charset). */
  contentType: string
  bytes: Uint8Array
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/** [network, prefixLength] pairs that are not publicly routable. */
const BLOCKED_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (includes cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved + broadcast
]

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value
}

function isBlockedIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return true // unparseable: fail closed
  return BLOCKED_IPV4.some(([network, prefix]) => {
    const base = ipv4ToInt(network) as number
    const size = 2 ** (32 - prefix)
    return value >= base && value < base + size
  })
}

/** Parses an IPv6 address (optionally with an embedded dotted quad) into eight 16-bit groups. */
function parseIPv6(input: string): number[] | null {
  let ip = input.replace(/%.*$/, '') // zone id
  // Embedded IPv4 tail, e.g. ::ffff:192.168.0.1
  const v4Match = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (v4Match) {
    const v4 = ipv4ToInt(v4Match[1])
    if (v4 === null) return null
    ip = `${ip.slice(0, -v4Match[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }

  const halves = ip.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  const parsed = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN))
  return parsed.some(Number.isNaN) ? null : parsed
}

function isBlockedIPv6(ip: string): boolean {
  const g = parseIPv6(ip)
  if (!g) return true // unparseable: fail closed

  const allZeroPrefix = (n: number): boolean => g.slice(0, n).every((x) => x === 0)
  const embeddedV4 = (hi: number, lo: number): string => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')

  // ::, ::1
  if (allZeroPrefix(7) && (g[7] === 0 || g[7] === 1)) return true
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  if (allZeroPrefix(5) && (g[5] === 0xffff || g[5] === 0)) return isBlockedIPv4(embeddedV4(g[6], g[7]))
  // NAT64 well-known prefix 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIPv4(embeddedV4(g[6], g[7]))
  }
  // 6to4 2002::/16 embeds an IPv4 address in groups 1-2
  if (g[0] === 0x2002) return isBlockedIPv4(embeddedV4(g[1], g[2]))
  if ((g[0] & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true // deprecated site-local fec0::/10
  if ((g[0] & 0xff00) === 0xff00) return true // multicast ff00::/8
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation 2001:db8::/32
  return false
}

/** True for any literal IP address that is not publicly routable. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip.replace(/%.*$/, ''))
  if (version === 4) return isBlockedIPv4(ip)
  if (version === 6) return isBlockedIPv6(ip)
  return false
}

function bareHostname(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

function isPrivateHostname(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (isIP(host)) return isPrivateAddress(host)
  return false
}

/**
 * Validates one hop of a fetch. Throws a human-readable error when the URL is
 * not http(s) or points at a private network.
 *
 * Note: resolving here and letting `fetch` resolve again leaves a small DNS
 * rebinding window. Closing it fully needs a pinned-address dispatcher; this
 * check still stops the common cases (typed-in private hosts, redirects to
 * internal services, names that plainly resolve to private ranges).
 */
async function assertPublicUrl(url: URL, resolveDns: boolean): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked: only http and https links can be imported (got ${url.protocol.replace(/:$/, '')}).`)
  }
  const host = bareHostname(url)
  if (!host) throw new Error('Blocked: the link has no host name.')
  if (isPrivateHostname(host)) throw new Error(`Blocked: ${host} is a private address`)
  if (!resolveDns || isIP(host)) return

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error(`Could not find ${host}. Check the link and your internet connection.`)
  }
  if (addresses.length === 0) throw new Error(`Could not find ${host}.`)
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`Blocked: ${host} is a private address`)
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = (): Error => new Error(`Page is larger than ${formatSize(maxBytes)}`)

  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (!res.body) return new Uint8Array(0)

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Fetches a public http(s) resource with SSRF protection, manual redirect
 * handling (each hop re-validated), a timeout, and a streaming size cap.
 * DNS checks are skipped when `fetchImpl` is injected (tests).
 */
export async function safeFetch(url: string, opts: FetchOptions & { accept?: string } = {}): Promise<FetchedResource> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const resolveDns = !opts.fetchImpl
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  let current: URL
  try {
    current = new URL(url.trim())
  } catch {
    throw new Error(`"${url}" is not a valid link.`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(current, resolveDns)

      let res: Response
      try {
        res = await fetchImpl(current.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: opts.accept ?? 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        })
      } catch (err) {
        if (controller.signal.aborted) throw timeoutError(current, timeoutMs)
        throw new Error(`Could not reach ${bareHostname(current)}: ${errorMessage(err)}`)
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => undefined)
        const location = res.headers.get('location')
        if (!location) throw new Error(`${bareHostname(current)} sent a redirect without a destination.`)
        if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`)
        try {
          current = new URL(location, current)
        } catch {
          throw new Error(`${bareHostname(current)} redirected to an invalid link.`)
        }
        continue
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        const reason = res.statusText ? ` ${res.statusText}` : ''
        throw new Error(`${bareHostname(current)} answered HTTP ${res.status}${reason}.`)
      }

      try {
        const bytes = await readCapped(res, maxBytes)
        return { finalUrl: current.href, contentType: res.headers.get('content-type') ?? '', bytes }
      } catch (err) {
        if (controller.signal.aborted) throw timeoutError(current, timeoutMs)
        throw err
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

function timeoutError(url: URL, timeoutMs: number): Error {
  return new Error(`Timed out after ${formatDuration(timeoutMs)} waiting for ${bareHostname(url)}.`)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // undici wraps the useful reason (ENOTFOUND, ECONNREFUSED, ...) in `cause`.
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return cause.message
    return err.message
  }
  return String(err)
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/** Lowercased hostname without a leading `www.`; empty string for invalid URLs. */
export function domainOf(url: string): string {
  try {
    return bareHostname(new URL(url)).replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Accepts loose allowlist entries such as "https://www.Wikipedia.org/" or "*.mit.edu". */
function normalizeAllowEntry(entry: string): string {
  let value = entry.trim().toLowerCase()
  if (!value) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    try {
      value = new URL(value).hostname
    } catch {
      return ''
    }
  }
  return value
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '')
}

/** Extra hosts implied by an allowlist entry (YouTube's short-link domain). */
const DOMAIN_ALIASES: Record<string, string[]> = {
  'youtube.com': ['youtu.be']
}

/**
 * True when the URL's host equals an allowlisted domain or is a subdomain of
 * one (`en.wikipedia.org` matches `wikipedia.org`).
 */
export function isDomainAllowed(url: string, allowlist: string[]): boolean {
  const host = domainOf(url)
  if (!host) return false
  const matches = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`)
  return allowlist.some((raw) => {
    const entry = normalizeAllowEntry(raw)
    if (!entry) return false
    return matches(entry) || (DOMAIN_ALIASES[entry] ?? []).some(matches)
  })
}
