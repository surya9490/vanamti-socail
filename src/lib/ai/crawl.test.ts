import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  crawlSite,
  CrawlError,
  extractText,
  extractTitle,
  extractLinks,
} from './crawl'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

// The crawler gates every URL on the SSRF guard — mock it so tests don't
// hit real DNS. Default: everything is deliverable; individual tests
// override for the reject path.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}))

interface RespOpts {
  status?: number
  contentType?: string
  location?: string
}

function htmlResponse(body: string, opts: RespOpts = {}): Response {
  const status = opts.status ?? 200
  const contentType = opts.contentType ?? 'text/html; charset=utf-8'
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase()
        if (key === 'content-type') return contentType
        if (key === 'location') return opts.location ?? null
        return null
      },
    },
    text: async () => body,
  } as unknown as Response
}

/** Stub fetch to serve a fixed site keyed by URL; 404 for anything else. */
function stubSite(site: Record<string, Response | string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const hit = site[url]
      if (hit === undefined) return htmlResponse('', { status: 404 })
      return typeof hit === 'string' ? htmlResponse(hit) : hit
    }),
  )
}

beforeEach(() => {
  vi.mocked(isDeliverableUrl).mockResolvedValue(true)
})
afterEach(() => vi.unstubAllGlobals())

describe('extractText', () => {
  it('strips scripts/styles/tags and decodes entities', () => {
    const html =
      '<html><head><title>x</title><style>.a{}</style></head>' +
      '<body><script>evil()</script><h1>Hello</h1><p>Honey &amp; bees &#39;n more</p></body></html>'
    const text = extractText(html)
    expect(text).toContain('Hello')
    expect(text).toContain("Honey & bees 'n more")
    expect(text).not.toContain('evil()')
    expect(text).not.toContain('.a{}')
    expect(text).not.toContain('<')
  })

  it('turns block boundaries into paragraph breaks', () => {
    const text = extractText('<p>one</p><p>two</p>')
    expect(text).toBe('one\ntwo')
  })
})

describe('extractTitle', () => {
  it('reads the <title> tag', () => {
    expect(extractTitle('<title> Vanamati &amp; Co </title>', 'https://x.com')).toBe(
      'Vanamati & Co',
    )
  })
  it('falls back to the host/path when there is no title', () => {
    expect(extractTitle('<body>no title</body>', 'https://x.com/shop')).toBe(
      'x.com/shop',
    )
  })
})

describe('extractLinks', () => {
  it('keeps same-origin links, resolves relative, drops others', () => {
    const html =
      '<a href="/about">a</a>' +
      '<a href="https://ex.com/shop">b</a>' +
      '<a href="https://other.com/x">ext</a>' +
      '<a href="#frag">f</a>' +
      '<a href="mailto:hi@ex.com">m</a>'
    const links = extractLinks(html, 'https://ex.com/')
    expect(links).toContain('https://ex.com/about')
    expect(links).toContain('https://ex.com/shop')
    expect(links).not.toContain('https://other.com/x')
    expect(links.some((l) => l.includes('#'))).toBe(false)
    expect(links.some((l) => l.startsWith('mailto'))).toBe(false)
  })
})

describe('crawlSite', () => {
  it('walks same-origin links breadth-first and extracts pages', async () => {
    stubSite({
      'https://ex.com/':
        '<html><head><title>Home</title></head><body><h1>Welcome to Vanamati honey shop</h1>' +
        '<p>We sell pure raw forest honey sourced ethically.</p>' +
        '<a href="/about">About</a><a href="https://other.com/x">ext</a></body></html>',
      'https://ex.com/about':
        '<html><head><title>About</title></head><body><p>We sell raw honey and share our sourcing story in detail here.</p></body></html>',
    })

    const pages = await crawlSite('https://ex.com', { maxPages: 10 })

    expect(pages.map((p) => p.url)).toEqual([
      'https://ex.com/',
      'https://ex.com/about',
    ])
    expect(pages[0].title).toBe('Home')
    expect(pages[0].text).toContain('Welcome to Vanamati')
    expect(pages[1].text).toContain('raw honey')
  })

  it('respects maxPages', async () => {
    stubSite({
      'https://ex.com/':
        '<html><body><p>This is the home page with plenty of body text to be indexed.</p>' +
        '<a href="/a">a</a><a href="/b">b</a></body></html>',
      'https://ex.com/a':
        '<html><body><p>Page A has enough readable body text to be kept by the crawler.</p></body></html>',
      'https://ex.com/b':
        '<html><body><p>Page B has enough readable body text to be kept by the crawler.</p></body></html>',
    })
    const pages = await crawlSite('https://ex.com', { maxPages: 1 })
    expect(pages).toHaveLength(1)
  })

  it('skips non-HTML responses', async () => {
    stubSite({
      'https://ex.com/':
        '<html><body><p>The home page has enough readable text to be indexed here.</p>' +
        '<a href="/doc.pdf">pdf</a></body></html>',
      'https://ex.com/doc.pdf': htmlResponse('%PDF-1.4 binary', {
        contentType: 'application/pdf',
      }),
    })
    const pages = await crawlSite('https://ex.com', { maxPages: 10 })
    expect(pages.map((p) => p.url)).toEqual(['https://ex.com/'])
  })

  it('throws CrawlError when the start URL is not deliverable (SSRF guard)', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false)
    stubSite({})
    await expect(crawlSite('https://internal.local')).rejects.toBeInstanceOf(
      CrawlError,
    )
  })

  it('throws CrawlError for a non-http URL', async () => {
    stubSite({})
    await expect(crawlSite('ftp://ex.com/file')).rejects.toBeInstanceOf(CrawlError)
  })
})
