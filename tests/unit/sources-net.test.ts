import { describe, expect, it, vi } from 'vitest'
import { domainOf, isDomainAllowed, isPrivateAddress, safeFetch } from '../../src/main/sources/net'

type FetchFn = typeof fetch

/** A fetch stub that serves canned responses keyed by URL and records calls. */
function routes(table: Record<string, () => Response>): FetchFn & { calls: string[]; inits: RequestInit[] } {
  const calls: string[] = []
  const inits: RequestInit[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    inits.push(init ?? {})
    const make = table[url]
    if (!make) throw new TypeError(`fetch failed: no route for ${url}`)
    return make()
  }) as FetchFn
  return Object.assign(impl, { calls, inits })
}

const redirect =
  (location: string, status = 302) =>
  (): Response =>
    new Response(null, { status, headers: { location } })

const html = (body: string) => (): Response => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002:c0a8:0101::1',
    'ff02::1',
    'fe80::1%en0'
  ])('blocks %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  it.each(['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false)
  })
})

describe('safeFetch', () => {
  it.each([
    ['http://localhost:3000/', 'localhost'],
    ['http://app.localhost/', 'app.localhost'],
    ['http://printer.local/status', 'printer.local'],
    ['http://metadata.google.internal/', 'metadata.google.internal'],
    ['http://127.0.0.1/', '127.0.0.1'],
    ['http://2130706433/', '127.0.0.1'], // decimal IPv4 is normalized by the URL parser
    ['http://0x7f.0.0.1/', '127.0.0.1'],
    ['http://192.168.0.10/', '192.168.0.10'],
    ['http://169.254.169.254/latest/meta-data', '169.254.169.254'],
    ['http://[::1]/', '::1'],
    ['http://[::ffff:10.0.0.1]/', '::ffff:a00:1']
  ])('rejects %s', async (url, host) => {
    const fetchImpl = routes({})
    await expect(safeFetch(url, { fetchImpl })).rejects.toThrow(`Blocked: ${host} is a private address`)
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('rejects non-http schemes', async () => {
    await expect(safeFetch('file:///etc/passwd', { fetchImpl: routes({}) })).rejects.toThrow(/only http and https/)
    await expect(safeFetch('ftp://example.com/x', { fetchImpl: routes({}) })).rejects.toThrow(/only http and https/)
  })

  it('rejects invalid URLs', async () => {
    await expect(safeFetch('not a url', { fetchImpl: routes({}) })).rejects.toThrow(/not a valid link/)
  })

  it('returns bytes, content type, and the final URL after redirects', async () => {
    const fetchImpl = routes({
      'https://example.com/start': redirect('/middle', 301),
      'https://example.com/middle': redirect('https://www.example.org/end', 307),
      'https://www.example.org/end': html('<p>hi</p>')
    })
    const result = await safeFetch('https://example.com/start', { fetchImpl })

    expect(result.finalUrl).toBe('https://www.example.org/end')
    expect(result.contentType).toBe('text/html; charset=utf-8')
    expect(new TextDecoder().decode(result.bytes)).toBe('<p>hi</p>')
    expect(fetchImpl.calls).toEqual(['https://example.com/start', 'https://example.com/middle', 'https://www.example.org/end'])
    for (const init of fetchImpl.inits) {
      expect(init.redirect).toBe('manual')
      expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/^Mozilla\/5\.0/)
    }
  })

  it('re-validates every redirect hop', async () => {
    const fetchImpl = routes({
      'https://example.com/': redirect('http://127.0.0.1:8080/admin'),
      'http://127.0.0.1:8080/admin': html('secret')
    })
    await expect(safeFetch('https://example.com/', { fetchImpl })).rejects.toThrow('Blocked: 127.0.0.1 is a private address')
    expect(fetchImpl.calls).toEqual(['https://example.com/'])
  })

  it('stops after five redirects', async () => {
    const table: Record<string, () => Response> = {}
    for (let i = 0; i < 10; i++) table[`https://example.com/${i}`] = redirect(`/${i + 1}`)
    const fetchImpl = routes(table)
    await expect(safeFetch('https://example.com/0', { fetchImpl })).rejects.toThrow(/Too many redirects/)
    expect(fetchImpl.calls).toHaveLength(6)
  })

  it('allows exactly five redirects', async () => {
    const table: Record<string, () => Response> = { 'https://example.com/5': html('ok') }
    for (let i = 0; i < 5; i++) table[`https://example.com/${i}`] = redirect(`/${i + 1}`)
    const result = await safeFetch('https://example.com/0', { fetchImpl: routes(table) })
    expect(result.finalUrl).toBe('https://example.com/5')
  })

  it('enforces the size cap while streaming', async () => {
    let pulled = 0
    const fetchImpl = routes({
      'https://example.com/big': () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled++
              controller.enqueue(new Uint8Array(1024))
              if (pulled > 1000) controller.close()
            }
          }),
          { headers: { 'content-type': 'application/pdf' } }
        )
    })
    await expect(safeFetch('https://example.com/big', { fetchImpl, maxBytes: 4096 })).rejects.toThrow('Page is larger than 4 KB')
    expect(pulled).toBeLessThan(10) // aborted early, not read to the end
  })

  it('rejects early on an oversized Content-Length and uses a human message', async () => {
    const fetchImpl = routes({
      'https://example.com/huge': () => new Response('x', { headers: { 'content-type': 'text/plain', 'content-length': String(30 * 1024 * 1024) } })
    })
    await expect(safeFetch('https://example.com/huge', { fetchImpl })).rejects.toThrow('Page is larger than 25 MB')
  })

  it('times out', async () => {
    const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as FetchFn
    await expect(safeFetch('https://slow.example.com/', { fetchImpl, timeoutMs: 30 })).rejects.toThrow('Timed out after 30 ms waiting for slow.example.com.')
  })

  it('reports HTTP errors and network failures clearly', async () => {
    const fetchImpl = routes({
      'https://example.com/missing': () => new Response('nope', { status: 404, statusText: 'Not Found' })
    })
    await expect(safeFetch('https://example.com/missing', { fetchImpl })).rejects.toThrow('example.com answered HTTP 404 Not Found.')
    await expect(safeFetch('https://example.com/down', { fetchImpl })).rejects.toThrow(/Could not reach example\.com/)
  })

  it('resolves DNS when no fetchImpl is injected and blocks private answers', async () => {
    vi.resetModules()
    vi.doMock('node:dns/promises', () => ({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 }
      ]
    }))
    try {
      const { safeFetch: guardedFetch } = await import('../../src/main/sources/net')
      await expect(guardedFetch('https://rebind.example.com/')).rejects.toThrow('Blocked: rebind.example.com is a private address')
    } finally {
      vi.doUnmock('node:dns/promises')
      vi.resetModules()
    }
  })
})

describe('domainOf', () => {
  it('lowercases and strips www.', () => {
    expect(domainOf('https://WWW.Example.COM/path')).toBe('example.com')
    expect(domainOf('https://en.wikipedia.org/wiki/X')).toBe('en.wikipedia.org')
    expect(domainOf('not a url')).toBe('')
  })
})

describe('isDomainAllowed', () => {
  const allow = ['wikipedia.org', 'https://www.Khanacademy.org/', '*.mit.edu', 'youtube.com']

  it.each([
    ['https://en.wikipedia.org/wiki/Eigenvalue', true],
    ['https://wikipedia.org/', true],
    ['https://www.khanacademy.org/math', true],
    ['https://ocw.mit.edu/courses', true],
    ['https://mit.edu/', true],
    ['https://www.youtube.com/watch?v=abc', true],
    ['https://m.youtube.com/watch?v=abc', true],
    ['https://youtu.be/abc', true],
    ['https://notwikipedia.org/', false],
    ['https://wikipedia.org.evil.com/', false],
    ['https://example.com/', false],
    ['garbage', false]
  ])('%s -> %s', (url, expected) => {
    expect(isDomainAllowed(url, allow)).toBe(expected)
  })

  it('does not let youtu.be through without a youtube.com entry', () => {
    expect(isDomainAllowed('https://youtu.be/abc', ['wikipedia.org'])).toBe(false)
  })
})
