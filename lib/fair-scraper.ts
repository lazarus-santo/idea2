import Anthropic from '@anthropic-ai/sdk'
import Browserbase from '@browserbasehq/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * One exhibitor. `section` is the fair's own grouping — The Armory Show splits its
 * roster across Galleries / Solo / Focus / Presents / Platform / Not-For-Profit,
 * each on its own page. Fairs that publish a single flat list leave it null.
 */
export interface FairExhibitor {
  name: string
  section: string | null
}

export interface FairPageResult {
  url: string
  section: string | null
  status: 'ok' | 'unreachable' | 'unparseable' | 'empty'
  found: number
  rejected: string[]
  page_chars: number
}

export interface FairExtraction {
  fair_name: string | null
  start_date: string | null
  end_date: string | null
  location: string | null
  exhibitors: FairExhibitor[]
  /** Names the model produced that were not found on their page — dropped, surfaced for review. */
  rejected: string[]
  method: 'browserbase' | 'http' | 'none'
  page_chars: number
  /** Per-page outcome, so one dead section page is visible rather than silently thinning the list. */
  pages: FairPageResult[]
}

// ─── Page fetch ───────────────────────────────────────────────────────────────
//
// Browserbase first. Fair exhibitor lists are the worst case for plain HTTP:
// they are long, frequently paginated or lazy-loaded, and often rendered client
// side from a JSON payload. Plain HTTP is kept as a fallback for the fairs that
// server-render, so a Browserbase outage does not block adding a fair.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function renderInSession(page: any, url: string, timeoutMs = 45000): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await page.waitForNetworkIdle({ idleTime: 1200, timeout: 10000 }).catch(() => {})

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

  // Some grids are IntersectionObserver-driven and never populate without the
  // viewport actually moving, however long you wait.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2))
    await new Promise((r) => setTimeout(r, 600))
  }
  return await page.content()
}

async function fetchViaHttp(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': FETCH_UA }, signal: AbortSignal.timeout(20000) })
    if (res.ok) {
      const html = await res.text()
      if (html.length > 1000) return html
    }
  } catch (err) {
    console.error(`Fair page HTTP failed for ${url}:`, (err as Error).message)
  }
  return ''
}

/**
 * Renders every URL inside a SINGLE Browserbase session.
 *
 * A sectioned fair means one page per section — six for The Armory Show. Opening
 * a session per page would multiply the cost of adding one fair by six for no
 * benefit, since the pages are on the same host and nothing is stateful between
 * them. Falls back to plain HTTP per-URL if the session cannot be created.
 */
async function fetchAll(urls: string[]): Promise<{ html: Map<string, string>; method: FairExtraction['method'] }> {
  const html = new Map<string, string>()
  try {
    const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! })
    const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID! })
    const puppeteer = await import('puppeteer')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const browser = await (puppeteer as any).connect({ browserWSEndpoint: session.connectUrl })
    try {
      const pages = await browser.pages()
      const page = pages[0] ?? await browser.newPage()
      for (const url of urls) {
        try {
          html.set(url, await renderInSession(page, url))
        } catch (err) {
          console.warn(`Fair page render failed for ${url}:`, (err as Error).message)
          html.set(url, '')
        }
      }
      if ([...html.values()].some((h) => h.length > 1000)) return { html, method: 'browserbase' }
    } finally {
      await browser.close().catch(() => {})
    }
  } catch (err) {
    console.warn('Fair Browserbase session failed — falling back to HTTP:', (err as Error).message)
  }

  for (const url of urls) {
    if ((html.get(url)?.length ?? 0) > 1000) continue
    html.set(url, await fetchViaHttp(url))
  }
  return { html, method: [...html.values()].some((h) => h.length > 1000) ? 'http' : 'none' }
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

/**
 * Removes the trailing location from an exhibitor name.
 *
 * Fairs print their rosters as "Gallery, City" — sometimes several cities:
 * "193 Gallery, Paris, Venice, Saint Tropez", "BANK, Shanghai, New York". The
 * model strips these inconsistently when asked to copy names exactly: on the
 * Armory's six pages it dropped them for Galleries and Presents and kept them
 * for Solo, Focus, Platform and Not-For-Profit — 64 of 241 names, split by page
 * rather than by anything in the data. Doing it in code instead of asking the
 * prompt more nicely is the only way to get a consistent result.
 *
 * Everything from the first comma is dropped. Verified against all 241 Armory
 * names: no gallery there carries a comma inside its own name, and the ones that
 * use other separators — Archeus / Post-Modern, Casterline|Goodman, EBONY/CURATED,
 * Uffner & Liu, Secrist | Beach — have no comma to trip on.
 *
 * The known cost: a gallery genuinely named "Something, Inc." would lose its
 * suffix. That is the accepted trade for consistency across the whole list.
 */
function stripLocation(name: string): string {
  const idx = name.indexOf(',')
  const base = idx === -1 ? name : name.slice(0, idx)
  return base.trim().replace(/[\s·–-]+$/, '').trim()
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
  "section_name": string | null,
  "exhibitors": string[]
}

Rules:
- exhibitors: every exhibiting gallery name shown on this page, copied EXACTLY as printed, INCLUDING any city or cities printed after the name (e.g. "193 Gallery, Paris, Venice, Saint Tropez"). Do not expand abbreviations, do not tidy punctuation, do not deduplicate variants that genuinely appear differently. The caller removes the location itself — copying it through keeps that removal consistent across pages.
- Include ONLY names actually present in the text below. Never infer, complete, or recall galleries you expect to be at this fair. An incomplete list is correct; an invented name is not.
- Exclude sponsors, partners, media partners, restaurants, and the fair's own sub-brands (e.g. "Armory Live", "Talks") — exhibiting galleries only.
- section_name: if this page covers one named section of the fair (e.g. "Galleries", "Solo", "Presents", "Platform", "Focus", "Not-For-Profit"), give that section's name. null if the page is the fair's full undivided list.
- location: the venue as printed (e.g. "The Javits Center", "Pier 36"), not a full postal address unless that is all that is given.
- Dates: the fair's public run dates, ONLY if an explicit day-level date or date range is printed on this page. A bare year, an edition name, or a year in the URL is not a date — return null. Never guess January 1st or any other placeholder. If only a preview/VIP day is separately listed, use the public opening as start_date.
  A section page usually carries no dates at all; null is the expected answer there.

Page content:
`

export interface FairPageInput {
  url: string
  /** Optional label for the fair's own grouping, e.g. "Galleries", "Solo", "Presents". */
  section?: string | null
}

/**
 * Extracts a fair's exhibitor roster from one or more pages.
 *
 * Most fairs publish a single flat list. Some split the roster by exhibitor type
 * across separate pages — The Armory Show has six (Galleries, Solo, Focus,
 * Presents, Platform, Not-For-Profit) at /galleries-2026, /solo-2026 and so on.
 * Passing several inputs merges them into one roster while recording which
 * section each name came from.
 *
 * Verification is per page, not against the merged text: a name only counts if it
 * appears on the page it was extracted from. Checking against the concatenation
 * would let a name hallucinated for Solo be validated by its presence in
 * Galleries, which is exactly the error worth catching on a sectioned fair.
 */
export async function scrapeFairExhibitors(inputs: FairPageInput[]): Promise<FairExtraction> {
  const urls = inputs.map((i) => i.url)
  const { html, method } = await fetchAll(urls)

  const exhibitors: FairExhibitor[] = []
  const rejected: string[] = []
  const pages: FairPageResult[] = []
  const seen = new Set<string>()
  let totalChars = 0
  let meta: { fair_name: string | null; start_date: string | null; end_date: string | null; location: string | null } = {
    fair_name: null, start_date: null, end_date: null, location: null,
  }

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

  // January 1st is rejected outright. Section pages carry no dates, and the model
  // reliably manufactures YYYY-01-01 from a bare year in the page or URL — the
  // Armory's six section pages all produced 2026-01-01. A real fair opening on
  // New Year's Day is vanishingly unlikely next to that failure mode, and the
  // admin can always type the true date, so the false positive is the cheaper
  // error. Anything else in YYYY-MM-DD form is taken at face value.
  const date = (v: unknown) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null
    const d = v.trim()
    if (d.endsWith('-01-01')) {
      console.warn(`Fair extraction: discarding suspected placeholder date ${d}`)
      return null
    }
    return d
  }

  for (const input of inputs) {
    const pageHtml = html.get(input.url) ?? ''
    const pageText = stripHtml(pageHtml)
    totalChars += pageText.length

    if (pageText.length < 200) {
      pages.push({ url: input.url, section: input.section ?? null, status: 'unreachable', found: 0, rejected: [], page_chars: pageText.length })
      continue
    }

    let raw: Record<string, unknown>
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{ role: 'user', content: EXTRACTION_PROMPT + pageText.slice(0, 120000) }],
      })
      const text = response.content.find((b) => b.type === 'text')?.text ?? ''
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) {
        console.error(`Fair extraction unparseable for ${input.url} (stop_reason: ${response.stop_reason})`)
        pages.push({ url: input.url, section: input.section ?? null, status: 'unparseable', found: 0, rejected: [], page_chars: pageText.length })
        continue
      }
      raw = JSON.parse(match[0])
    } catch (err) {
      console.error(`Fair extraction failed for ${input.url}:`, (err as Error).message)
      pages.push({ url: input.url, section: input.section ?? null, status: 'unparseable', found: 0, rejected: [], page_chars: pageText.length })
      continue
    }

    // Fair-level metadata: first page that supplies a value wins. Section pages
    // repeat the fair name and dates, so later pages have nothing to add.
    meta = {
      fair_name: meta.fair_name ?? str(raw.fair_name),
      start_date: meta.start_date ?? date(raw.start_date),
      end_date: meta.end_date ?? date(raw.end_date),
      location: meta.location ?? str(raw.location),
    }

    // Anti-hallucination: every name must be literally present in THIS page.
    // Deterministic rather than a model call — a roster runs to hundreds of names,
    // so per-name verification would be slow and expensive, and a string match is
    // the stricter test anyway.
    const haystack = normalize(pageText)
    const section = input.section ?? str(raw.section_name) ?? null
    const pageRejected: string[] = []
    let found = 0

    for (const candidate of Array.isArray(raw.exhibitors) ? raw.exhibitors : []) {
      const printed = String(candidate).trim()
      if (!printed || printed.length < 2) continue

      // Verified as printed — the stricter test, since the page contains the
      // location too. Stripping first would let a hallucinated "X, Berlin" pass
      // on the strength of an unrelated "X" elsewhere on the page.
      const printedKey = normalize(printed)
      if (!printedKey) continue
      if (!haystack.includes(printedKey)) { pageRejected.push(printed); continue }

      const name = stripLocation(printed)
      if (name.length < 2) continue
      // Dedupe on the stripped form so "BANK, Shanghai, New York" and a bare
      // "BANK" on another section page collapse to one entry. First section
      // encountered wins, matching the order the admin supplied.
      const key = normalize(name)
      if (seen.has(key)) continue
      seen.add(key)
      exhibitors.push({ name, section })
      found++
    }

    if (pageRejected.length > 0) {
      console.warn(`Fair ${input.url}: dropped ${pageRejected.length} name(s) not found on that page:`, pageRejected.slice(0, 10))
      rejected.push(...pageRejected)
    }
    pages.push({
      url: input.url,
      section,
      status: found > 0 ? 'ok' : 'empty',
      found,
      rejected: pageRejected,
      page_chars: pageText.length,
    })
  }

  return { ...meta, exhibitors, rejected, method, page_chars: totalChars, pages }
}
