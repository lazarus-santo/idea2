import Anthropic from '@anthropic-ai/sdk'
import Browserbase from '@browserbasehq/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface FairExtraction {
  fair_name: string | null
  start_date: string | null
  end_date: string | null
  location: string | null
  exhibitors: string[]
  /** Names the model produced that could not be found on the page — dropped, reported for visibility. */
  rejected: string[]
  method: 'browserbase' | 'http' | 'none'
  page_chars: number
}

// ─── Page fetch ───────────────────────────────────────────────────────────────
//
// Browserbase first. Fair exhibitor lists are the worst case for plain HTTP:
// they are long, frequently paginated or lazy-loaded, and often rendered client
// side from a JSON payload. Plain HTTP is kept as a fallback for the fairs that
// server-render, so a Browserbase outage does not block adding a fair.

async function fetchViaBrowserbase(url: string, timeoutMs = 45000): Promise<string> {
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! })
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID! })
  const puppeteer = await import('puppeteer')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const browser = await (puppeteer as any).connect({ browserWSEndpoint: session.connectUrl })
  try {
    const pages = await browser.pages()
    const page = pages[0] ?? await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page as any).waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {})

    // Exhibitor lists are commonly paginated behind a "load more". Same treatment
    // Agent 1 gives listing pages, with a higher ceiling: a fair can list 200+
    // galleries where a gallery lists a handful of shows.
    for (let i = 0; i < 8; i++) {
      const clicked = await page.evaluate(() => {
        const re = /load more|show more|see more|view all|next/i
        const els = Array.from(document.querySelectorAll('button, a[href], [role="button"]'))
        const btn = els.find((el) => re.test(el.textContent?.trim() ?? ''))
        if (btn) { (btn as HTMLElement).click(); return true }
        return false
      })
      if (!clicked) break
      await new Promise((r) => setTimeout(r, 1500))
    }
    return await page.content()
  } finally {
    await browser.close().catch(() => {})
  }
}

async function fetchPage(url: string): Promise<{ html: string; method: FairExtraction['method'] }> {
  try {
    const html = await fetchViaBrowserbase(url)
    if (html.length > 1000) return { html, method: 'browserbase' }
  } catch (err) {
    console.warn(`Fair page Browserbase failed for ${url} — falling back to HTTP:`, (err as Error).message)
  }
  try {
    const res = await fetch(url, { headers: { 'User-Agent': FETCH_UA }, signal: AbortSignal.timeout(20000) })
    if (res.ok) {
      const html = await res.text()
      if (html.length > 1000) return { html, method: 'http' }
    }
  } catch (err) {
    console.error(`Fair page HTTP also failed for ${url}:`, (err as Error).message)
  }
  return { html: '', method: 'none' }
}

// ─── Text normalisation for the presence check ────────────────────────────────
//
// Gallery names are punctuation-heavy and inconsistently typeset: curly vs
// straight apostrophes, & vs "and", accented characters, non-breaking spaces,
// hyphen variants. Comparing raw strings would reject real exhibitors over
// typography, so both sides are flattened before matching.

function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')       // strip diacritics
    .replace(/[‘’‛]/g, "'")  // curly single quotes
    .replace(/[“”]/g, '"')        // curly double quotes
    .replace(/[‐-―]/g, '-')       // dash variants
    .replace(/ /g, ' ')                // nbsp
    .replace(/&amp;/g, '&')
    .replace(/\band\b/gi, '&')              // "Smith and Jones" == "Smith & Jones"
    .replace(/[^\w\s&'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const EXTRACTION_PROMPT = `You are reading the exhibitor list page for an art fair.

Return ONLY a JSON object, no commentary:
{
  "fair_name": string | null,
  "start_date": "YYYY-MM-DD" | null,
  "end_date": "YYYY-MM-DD" | null,
  "location": string | null,
  "exhibitors": string[]
}

Rules:
- exhibitors: every exhibiting gallery name shown on this page, copied EXACTLY as printed. Do not expand abbreviations, do not add cities, do not tidy punctuation, do not deduplicate variants that genuinely appear differently.
- Include ONLY names actually present in the text below. Never infer, complete, or recall galleries you expect to be at this fair. An incomplete list is correct; an invented name is not.
- Exclude sponsors, partners, media partners, restaurants, and the fair's own sub-brands (e.g. "Armory Live", "Talks") — exhibiting galleries only.
- location: the venue as printed (e.g. "The Javits Center", "Pier 36"), not a full postal address unless that is all that is given.
- Dates: the fair's public run dates. If only a preview/VIP day is separately listed, use the public opening as start_date.

Page content:
`

export async function scrapeFairExhibitors(url: string): Promise<FairExtraction> {
  const { html, method } = await fetchPage(url)
  const empty: FairExtraction = {
    fair_name: null, start_date: null, end_date: null, location: null,
    exhibitors: [], rejected: [], method, page_chars: 0,
  }
  if (!html) return empty

  const pageText = stripHtml(html)
  if (pageText.length < 200) return { ...empty, page_chars: pageText.length }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: EXTRACTION_PROMPT + pageText.slice(0, 120000) }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    console.error(`Fair extraction returned unparseable response for ${url} (stop_reason: ${response.stop_reason})`)
    return { ...empty, page_chars: pageText.length }
  }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(match[0])
  } catch {
    console.error(`Fair extraction JSON.parse failed for ${url}`)
    return { ...empty, page_chars: pageText.length }
  }

  // Anti-hallucination: every exhibitor must be literally present in the page.
  // Deterministic rather than a model call — an exhibitor list runs to hundreds
  // of names, so per-name LLM verification would be both slow and expensive, and
  // a string match is the stricter test anyway.
  const haystack = normalize(pageText)
  const seen = new Set<string>()
  const exhibitors: string[] = []
  const rejected: string[] = []

  for (const candidate of Array.isArray(raw.exhibitors) ? raw.exhibitors : []) {
    const name = String(candidate).trim()
    if (!name || name.length < 2) continue
    const key = normalize(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (haystack.includes(key)) exhibitors.push(name)
    else rejected.push(name)
  }

  if (rejected.length > 0) {
    console.warn(`Fair ${url}: dropped ${rejected.length} exhibitor(s) not found on the page:`, rejected.slice(0, 10))
  }

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null)

  return {
    fair_name: str(raw.fair_name),
    start_date: date(raw.start_date),
    end_date: date(raw.end_date),
    location: str(raw.location),
    exhibitors,
    rejected,
    method,
    page_chars: pageText.length,
  }
}
