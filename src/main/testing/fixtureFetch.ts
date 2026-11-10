import { readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, resolve } from 'node:path'

/**
 * End-to-end test support only (enabled by MINT_E2E_FIXTURES). Serves URL
 * imports from local fixture files so tests never depend on the network.
 * The SSRF guard still checks every URL (scheme, private hosts and literal
 * addresses); only its DNS lookup is skipped for an injected fetch, since
 * fixture hosts need not resolve.
 */
export function createFixtureFetch(mapPath: string): typeof fetch {
  const map = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain' }
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const entry = map[url]
    // Relative fixture paths resolve against the map file, so the map works on any machine.
    const file = entry && (isAbsolute(entry) ? entry : resolve(dirname(mapPath), entry))
    if (!file) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    return new Response(readFileSync(file), { status: 200, headers: { 'content-type': types[extname(file)] ?? 'application/octet-stream' } })
  }) as typeof fetch
}
