import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

// ============================================================
// Website crawler for the knowledge base.
//
// Same-origin breadth-first walk from a start URL, extracting readable
// text per page to feed `ingestDocument`. Deliberately dependency-free:
// a regex tag-strip is good enough to turn a marketing / docs page into
// searchable prose, and avoids pulling a heavyweight HTML parser into
// the server bundle.
//
// SSRF: the start URL is admin-supplied and WE fetch it, so every URL
// (start + each followed link, re-checked on dequeue) is run through
// `isDeliverableUrl` and redirects are handled manually — the same
// discipline as outbound webhook delivery (src/lib/webhooks/ssrf.ts).
// ============================================================

export interface CrawledPage {
  url: string
  title: string
  text: string
}

export interface CrawlOptions {
  maxPages?: number
  timeoutMs?: number
}

/** A user-actionable crawl failure (bad URL / unreachable / private). */
export class CrawlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CrawlError'
  }
}

const DEFAULT_MAX_PAGES = 10
const HARD_MAX_PAGES = 30
const DEFAULT_TIMEOUT_MS = 15_000
/** Don't process absurdly large documents (guards memory + token spend). */
const MAX_HTML_BYTES = 4_000_000
/** Bound the text stored per page — chunkText handles windowing below this. */
const MAX_TEXT_CHARS = 40_000
/** Skip pages with essentially no prose (nav-only shells, redirects). */
const MIN_TEXT_CHARS = 40

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, ent: string) => {
    if (ent[0] === '#') {
      const code =
        ent[1] === 'x' || ent[1] === 'X'
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? match
  })
}

/** Pull a page title from `<title>`, falling back to the URL path. */
export function extractTitle(html: string, fallbackUrl: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const raw = m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
  if (raw) return raw.slice(0, 200)
  try {
    const u = new URL(fallbackUrl)
    return (u.pathname === '/' ? u.hostname : `${u.hostname}${u.pathname}`).slice(0, 200)
  } catch {
    return fallbackUrl.slice(0, 200)
  }
}

/** Strip HTML to readable, newline-separated prose. */
export function extractText(html: string): string {
  let s = html
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  // Drop non-content elements wholesale.
  s = s.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
  // Block-level boundaries become newlines so paragraphs survive.
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(
    /<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6])\s*>/gi,
    '\n',
  )
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\f\r]+/g, ' ')
  s = s
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return s.slice(0, MAX_TEXT_CHARS)
}

/** Same-origin absolute links found in `<a href>`, with fragments removed. */
export function extractLinks(html: string, baseUrl: string): string[] {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return []
  }
  const out = new Set<string>()
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = (m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (
      !href ||
      href.startsWith('#') ||
      /^(mailto:|tel:|javascript:|data:)/i.test(href)
    ) {
      continue
    }
    let u: URL
    try {
      u = new URL(href, base)
    } catch {
      continue
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    if (u.origin !== base.origin) continue
    u.hash = ''
    out.add(u.toString())
  }
  return Array.from(out)
}

/**
 * Crawl `startUrl` and return up to `maxPages` pages of extracted text.
 * Throws `CrawlError` for an invalid / unreachable / private start URL;
 * individual pages that fail are skipped, not fatal.
 */
export async function crawlSite(
  startUrl: string,
  opts: CrawlOptions = {},
): Promise<CrawledPage[]> {
  const maxPages = Math.min(
    HARD_MAX_PAGES,
    Math.max(1, Math.floor(opts.maxPages ?? DEFAULT_MAX_PAGES)),
  )
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let start: URL
  try {
    start = new URL(startUrl)
  } catch {
    throw new CrawlError('Enter a valid URL, including https://')
  }
  if (start.protocol !== 'http:' && start.protocol !== 'https:') {
    throw new CrawlError('Only http and https URLs can be imported.')
  }
  start.hash = ''
  if (!(await isDeliverableUrl(start.toString()))) {
    throw new CrawlError(
      'That URL could not be reached, or points to a private/internal address.',
    )
  }

  const startStr = start.toString()
  const queue: string[] = [startStr]
  const seen = new Set<string>(queue)
  const pages: CrawledPage[] = []

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift() as string
    // Re-validate every followed URL (the start URL was already checked).
    if (url !== startStr && !(await isDeliverableUrl(url))) continue

    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Vanamati-KB-Crawler',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      continue
    }

    // Follow a same-origin redirect by enqueueing its target rather than
    // letting fetch bounce us (possibly onto an internal host).
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (loc) {
        try {
          const next = new URL(loc, url)
          next.hash = ''
          const nextStr = next.toString()
          if (next.origin === start.origin && !seen.has(nextStr)) {
            seen.add(nextStr)
            queue.push(nextStr)
          }
        } catch {
          // Unparseable Location — ignore.
        }
      }
      continue
    }
    if (!res.ok) continue

    const ctype = res.headers.get('content-type') ?? ''
    if (!/text\/html|application\/xhtml/i.test(ctype)) continue

    let html: string
    try {
      html = await res.text()
    } catch {
      continue
    }
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES)

    const text = extractText(html)
    if (text.length >= MIN_TEXT_CHARS) {
      pages.push({ url, title: extractTitle(html, url), text })
    }

    if (pages.length < maxPages) {
      for (const link of extractLinks(html, url)) {
        if (!seen.has(link)) {
          seen.add(link)
          queue.push(link)
        }
      }
    }
  }

  return pages
}
