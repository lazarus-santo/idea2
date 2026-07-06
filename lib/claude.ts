import Anthropic from '@anthropic-ai/sdk'
import Exa from 'exa-js'
import { getSupabaseAdmin } from './supabase'
import type { ExhibitionRaw, Preread, CoverageItem, ExhibitionLink, ExhibitionDetailExtracted } from './types'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

const BETA_HEADERS = { 'anthropic-beta': 'prompt-caching-2024-07-31' }

// ─── Robust JSON extraction ────────────────────────────────────────────────────
// Claude occasionally second-guesses itself mid-response (e.g. "Wait, that's
// wrong — here's the corrected version") and includes more than one JSON blob
// in one answer. A naive first-bracket-to-last-bracket regex stitches both
// attempts into one invalid blob and silently returns nothing. This scans for
// every top-level bracket-balanced candidate (respecting string literals so
// brackets inside quoted text don't confuse the depth count) and keeps the
// last one that parses on its own — the corrected, final answer wins.
function scanBalancedJson<T>(text: string, open: string, close: string): T | null {
  let depth = 0
  let start = -1
  let inString = false
  let escapeNext = false
  let lastValid: T | null = null

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escapeNext) escapeNext = false
      else if (ch === '\\') escapeNext = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === open) {
      if (depth === 0) start = i
      depth++
    } else if (ch === close) {
      depth = Math.max(0, depth - 1)
      if (depth === 0 && start !== -1) {
        try {
          lastValid = JSON.parse(text.slice(start, i + 1)) as T
        } catch {
          // not valid JSON on its own — keep scanning for a later candidate
        }
        start = -1
      }
    }
  }
  return lastValid
}

function extractJsonArray<T = unknown>(text: string): T[] | null {
  return scanBalancedJson<T[]>(text, '[', ']')
}

function extractJsonObject<T = unknown>(text: string): T | null {
  return scanBalancedJson<T>(text, '{', '}')
}

// ─── Exa tier routing ─────────────────────────────────────────────────────────

const TIER_1_DOMAINS = [
  'artforum.com', 'frieze.com', 'theartnewspaper.com', 'hyperallergic.com',
  'artnews.com', 'brooklynrail.org', 'bombmagazine.org', 'e-flux.com',
]
const TIER_2_DOMAINS = [
  'nytimes.com', 'newyorker.com', 'theguardian.com', 'ft.com',
  'wsj.com', 'vulture.com', 'nymag.com',
]
const DOMAIN_TO_PUBLICATION: Record<string, string> = {
  'artforum.com': 'Artforum',
  'frieze.com': 'Frieze',
  'theartnewspaper.com': 'The Art Newspaper',
  'hyperallergic.com': 'Hyperallergic',
  'artnews.com': 'ARTnews',
  'brooklynrail.org': 'The Brooklyn Rail',
  'bombmagazine.org': 'BOMB Magazine',
  'e-flux.com': 'e-flux',
  'nytimes.com': 'The New York Times',
  'newyorker.com': 'The New Yorker',
  'theguardian.com': 'The Guardian',
  'ft.com': 'Financial Times',
  'wsj.com': 'The Wall Street Journal',
  'vulture.com': 'Vulture',
  'nymag.com': 'New York Magazine',
}

function getResultDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function getResultTier(url: string): 1 | 2 | 3 {
  const host = getResultDomain(url)
  if (TIER_1_DOMAINS.some((d) => host.includes(d))) return 1
  if (TIER_2_DOMAINS.some((d) => host.includes(d))) return 2
  return 3
}

// ─── Gallery URL filtering ────────────────────────────────────────────────────

// Extracts the registrable domain (e.g. anthonygallery.com from shop.anthonygallery.com)
function registrableDomain(url: string): string {
  try {
    const parts = new URL(url).hostname.replace(/^www\./, '').split('.')
    return parts.length >= 2 ? parts.slice(-2).join('.') : parts[0]
  } catch {
    return ''
  }
}

// Heuristic: "gallery" / variants appearing anywhere in the hostname.
// "hyperallergic" is safe — it doesn't contain these substrings.
const GALLERY_HOSTNAME_RE = /gallery|galerie|galleria|gallerie/i

// Pulls all known venue domains from the DB once per preread generation call.
async function buildGalleryBlocklist(): Promise<Set<string>> {
  const { data } = await getSupabaseAdmin().from('venues').select('exhibitions_url')
  const domains = new Set<string>()
  for (const v of data ?? []) {
    const d = registrableDomain(v.exhibitions_url as string)
    if (d) domains.add(d)
  }
  return domains
}

// Artsy editorial paths are allowed; artist database pages (/artist/...) are not.
function isArtsyArtistPage(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url)
    return hostname.includes('artsy.net') && /^\/artist\//.test(pathname)
  } catch {
    return false
  }
}

// Group-show keywords in a title signal the artist is one of many, not the primary subject.
const GROUP_CONTEXT_RE = /biennial|art fair|group show|survey show|open call|prize|award|residency/i

function isStandaloneArticle(title: string | null, artistQuery: string): boolean {
  if (!title) return false
  const t = title.toLowerCase()
  if (GROUP_CONTEXT_RE.test(t)) return false
  // At least one part of the artist name should appear in the title
  return artistQuery.toLowerCase().split(/[\s,]+/).filter((p) => p.length > 2).some((p) => t.includes(p))
}

function isBlockedUrl(url: string, galleryDomains: Set<string>): boolean {
  const host = getResultDomain(url)
  if (host.includes('wikipedia.org')) return true
  if (host.includes('substack.com')) return true
  if (isArtsyArtistPage(url)) return true
  if (galleryDomains.has(registrableDomain(url))) return true
  if (GALLERY_HOSTNAME_RE.test(host)) return true
  return false
}

// Subdomains that are infrastructure, not the publication name itself.
const STRIP_SUBDOMAIN_RE = /^(www|shop|blog|store|news|press|web|m|app|media)\./i

function publicationFromUrl(url: string): string | null {
  const host = getResultDomain(url)
  for (const [domain, name] of Object.entries(DOMAIN_TO_PUBLICATION)) {
    if (host.includes(domain)) return name
  }
  // Strip known non-name subdomains, then take the first segment before the TLD.
  const cleaned = host.replace(STRIP_SUBDOMAIN_RE, '').split('.')[0]
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : null
}

const EXTRACTION_SYSTEM: Anthropic.Messages.TextBlockParam = {
  type: 'text',
  text: `You are a data extraction assistant. Your job is to find exhibitions that are CURRENTLY ON VIEW at a specific gallery and return structured JSON.

CRITICAL RULES:
- Only extract NYC exhibitions. Exclude any show taking place outside New York City (e.g. art fairs, biennials, or shows at international venues).
- Only extract exhibitions that are open RIGHT NOW.
- Pay close attention to page structure. Gallery websites typically organize exhibitions into sections: "Current" / "On View" / "Now On View" for active shows, and "Archive" / "Past" / "Previous" / "Upcoming" / "Coming Soon" / "Future" for everything else.
- If a show appears under an "Archive", "Past", "Previous", or similar section heading, DO NOT include it — even if no end date is visible.
- If a show appears under "Upcoming", "Coming Soon", "Future", or similar, DO NOT include it.
- Only include shows clearly marked as current, or shows with a date range that spans today's date.
- RULE 1 — MISSING FIELDS: If start_date, end_date, or image_url are missing for any exhibition, AND a URL for that exhibition's individual page was found anywhere in the HTML or in your own description, you MUST use web_search to fetch that URL before returning the record. Do not return a record with null required fields if a URL is available to check. This is mandatory, not optional.
- RULE 2 — EMPTY HTML: If the HTML slice contains no exhibition titles, artist names, or date patterns — meaning it appears to be navigation, boilerplate, or a page header only — you MUST trigger web_search immediately to find what is currently on view at the venue. Do not return [] from HTML alone without first attempting a web search. Search for "[venue name] current exhibitions [current year]".

Always return a JSON array. Return [] if nothing is currently on view.
Dates in YYYY-MM-DD format or null.
Artists as an array of strings.
The output must be valid JSON: any double-quote character that is part of extracted text (e.g. a quoted phrase copied verbatim) must be escaped as \\" so it does not terminate the JSON string early.`,
  cache_control: { type: 'ephemeral' },
}


export async function extractExhibitionsFromPage(
  html: string,
  venueName: string,
  url: string
): Promise<ExhibitionRaw[]> {
  const response = await anthropic.messages.create(
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 } as any],
      system: [EXTRACTION_SYSTEM],
      messages: [
        {
          role: 'user',
          content: `Find all exhibitions CURRENTLY ON VIEW at ${venueName} (${url}). NYC shows only — exclude any exhibition taking place outside New York City.

Read the page structure carefully. Look for section headings like "Current", "On View", "Now On View", "Archive", "Past", "Upcoming". Only extract from the current/on-view section. Ignore anything under Archive, Past, or Upcoming sections entirely.

Step 1 — SEARCH FIRST: Before reading the HTML, use web_search to search for "${venueName} current exhibitions 2026". This is mandatory on every call.
Step 2 — FILL GAPS: For any exhibition where start_date, end_date, or image_url is still missing after Step 1, use web_search again to fetch that exhibition's individual page URL (look for it in the HTML or search results). Do not return a record with null required fields if a page URL exists to check.
Step 3 — CROSS-REFERENCE: Use the HTML provided to confirm and supplement what you found in Steps 1 and 2.
Step 4 — RETURN RESULTS: Return only currently open NYC exhibitions with all available fields populated.

For each currently open NYC exhibition return:
- show_title: the exhibition title
- artists: array of artist names
- start_date: YYYY-MM-DD or null
- end_date: YYYY-MM-DD or null
- description: 2-3 sentences about the show itself. Do NOT mention the gallery. Null if unavailable.
- press_release: the full verbatim press release text for this show if it appears anywhere on the page or in the individual exhibition page. Copy it exactly, including paragraph breaks. Null if not found.
- image_url: absolute URL of the main exhibition image (must start with http). Null if not found.

Return ONLY a JSON array:
[
  {
    "show_title": "...",
    "artists": ["..."],
    "start_date": "YYYY-MM-DD",
    "end_date": "YYYY-MM-DD",
    "description": "...",
    "press_release": "...",
    "image_url": "https://..."
  }
]

HTML content:
${html
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .slice(0, 20000)}`,
        },
      ],
    },
    { headers: BETA_HEADERS }
  )

  const textBlocks = response.content.filter((b) => b.type === 'text')
  const lastText = textBlocks[textBlocks.length - 1]
  if (!lastText || lastText.type !== 'text') return []

  const parsed = extractJsonArray<ExhibitionRaw>(lastText.text)
  if (!parsed) {
    console.error(`Failed to parse exhibitions JSON for ${venueName}:`, lastText.text.slice(0, 200))
    return []
  }
  return parsed
}

type PrereadRow = Omit<Preread, 'id' | 'exhibition_id' | 'created_at'>
export interface GeneratePrereadsResult {
  prereads: PrereadRow[]
  hasShowCoverage: boolean
}

// contentPriority: 0 = show review (S2), 1 = artist profile/interview (S1), 2 = general press (S3/S4)
interface PoolResult {
  title: string | null
  url: string
  publishedDate?: string
  highlights: string[]
  image?: string
  contentPriority: 0 | 1 | 2
}

function sortByTierAndRecency<T extends { url: string; publishedDate?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const tierDiff = getResultTier(a.url) - getResultTier(b.url)
    if (tierDiff !== 0) return tierDiff
    const dateA = a.publishedDate ? new Date(a.publishedDate).getTime() : 0
    const dateB = b.publishedDate ? new Date(b.publishedDate).getTime() : 0
    return dateB - dateA
  })
}

function toPrereadRow(r: PoolResult & { title: string }): PrereadRow {
  return {
    article_title: r.title,
    publication: publicationFromUrl(r.url),
    article_url: r.url,
    summary: r.highlights?.[0] ?? null,
    thumbnail_url: r.image ?? null,
  }
}

export async function generatePrereads(
  exhibition: ExhibitionRaw & { venue_name: string }
): Promise<GeneratePrereadsResult> {
  const exa = new Exa(process.env.EXA_API_KEY!)
  const showTitle = exhibition.show_title
  const isGroupShow = exhibition.artists.length > 3

  // Build blocklist once — shared across all search paths
  const galleryDomains = await buildGalleryBlocklist()
  const isValid = (r: PoolResult): r is PoolResult & { title: string } =>
    !!r.title?.trim() && !isBlockedUrl(r.url, galleryDomains)

  // ─── Group show path ──────────────────────────────────────────────────────
  // S2 for the overall show review + one parallel search per artist (≤5).
  // Result: [show review] + [best article per artist], no 3-preread cap.
  if (isGroupShow) {
    const artistsToSearch = exhibition.artists.slice(0, 5)

    // Per-artist searches only — no dedicated show-review search.
    // Show reviews surface naturally if they rank in per-artist results.
    // Each call is isolated so one failure doesn't abort the rest.
    const artistSearches = await Promise.all(
      artistsToSearch.map((artist) =>
        exa.search(`${artist} visual artist`, {
          type: 'auto',
          numResults: 5,
          startPublishedDate: '2024-01-01',
          contents: { highlights: true },
        }).catch(() => ({ results: [] as PoolResult[] }))
      )
    )

    // Per-artist: pick the single best valid result for each artist.
    // Dedup by URL and domain — no two artists share a source.
    const seenUrls = new Set<string>()
    const seenDomains = new Set<string>()
    const perArtistRows: PrereadRow[] = []
    for (let i = 0; i < artistsToSearch.length; i++) {
      const artist = artistsToSearch[i]
      const results = artistSearches[i].results as unknown as PoolResult[]
      const candidates = sortByTierAndRecency(
        results.filter(isValid).filter((r) => !seenUrls.has(r.url) && !seenDomains.has(registrableDomain(r.url)))
      )
      if (candidates.length > 0) {
        const best = { ...candidates[0], contentPriority: 1 as const }
        seenUrls.add(best.url)
        seenDomains.add(registrableDomain(best.url))
        perArtistRows.push(toPrereadRow(best))
        console.log(`Exa per-artist [${artist}]:`, { title: best.title, url: best.url })
      } else {
        console.log(`Exa per-artist [${artist}]: no valid results`)
      }
    }

    const prereads: PrereadRow[] = [...perArtistRows]

    // S4 fallback: only fires when per-artist searches produced very little
    if (prereads.length < 2) {
      const search4 = await exa.search(`"${showTitle}" ${exhibition.venue_name} art exhibition`, {
        type: 'auto',
        numResults: 5,
        startPublishedDate: '2023-01-01',
        contents: { highlights: true },
      })
      console.log(`Exa S4 [group fallback]:`, search4.results.map((r) => ({ title: r.title, url: r.url })))
      const extra = sortByTierAndRecency(
        (search4.results as unknown as PoolResult[])
          .filter(isValid)
          .filter((r) => !seenUrls.has(r.url) && !seenDomains.has(registrableDomain(r.url)))
          .map((r) => ({ ...r, contentPriority: 2 as const }))
      )
      prereads.push(...extra.slice(0, 2 - prereads.length).map(toPrereadRow))
    }

    console.log(`Exa selected [${showTitle}]:`, prereads.map((p) => ({ title: p.article_title, pub: p.publication })))
    return { prereads, hasShowCoverage: false }
  }

  // ─── Solo / duo / trio path (≤3 artists) ─────────────────────────────────
  const artistQuery = exhibition.artists.join(', ')

  // S1: broad recent coverage — not limited to interviews so reviews, essays, and features all qualify
  const search1 = await exa.search(`${artistQuery} artist`, {
    type: 'auto',
    numResults: 5,
    startPublishedDate: '2024-01-01',
    contents: { highlights: true },
  })
  console.log(`Exa S1 [${artistQuery}]:`, search1.results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate })))

  const search2 = await exa.search(`${artistQuery} artwork practice critical essay`, {
    type: 'auto',
    numResults: 5,
    startPublishedDate: '2022-01-01',
    contents: { highlights: true },
  })
  console.log(`Exa S2 [body of work / ${artistQuery}]:`, search2.results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate })))

  // S3: explicitly target Tier 1 art press + major general press — ensures The Art Newspaper,
  // Artforum, Frieze, Hyperallergic etc. are always in the candidate pool
  const search3 = await exa.search(`${artistQuery} artist`, {
    type: 'auto',
    numResults: 5,
    startPublishedDate: '2024-01-01',
    includeDomains: [...TIER_1_DOMAINS, 'newyorker.com', 'ft.com', 'vulture.com', 'nymag.com'],
    contents: { highlights: true },
  })
  console.log(`Exa S3 [art + major press / ${artistQuery}]:`, search3.results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate })))

  const seenUrls = new Set<string>()
  const pool: PoolResult[] = []

  const addToPool = (results: typeof search1.results, contentPriority: 0 | 1 | 2) => {
    for (const r of results) {
      if (seenUrls.has(r.url)) continue
      seenUrls.add(r.url)
      pool.push({ ...(r as unknown as PoolResult), contentPriority })
    }
  }

  addToPool(search2.results, 0)
  addToPool(search1.results, 1)
  addToPool(search3.results, 2)

  let valid = pool.filter(isValid)

  if (valid.length < 2) {
    const search4 = await exa.search(`${artistQuery} art review profile`, {
      type: 'auto',
      numResults: 5,
      startPublishedDate: '2023-01-01',
      contents: { highlights: true },
    })
    console.log(`Exa S4 [fallback]:`, search4.results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate })))
    addToPool(search4.results, 2)
    valid = pool.filter(isValid)
  } else {
    console.log(`Exa S4 skipped (${valid.length} valid results after filtering)`)
  }

  // Sort: tier → content type → standalone-artist signal → recency
  // Tier wins first: Artforum always beats a Tier 3 blog regardless of content type.
  valid.sort((a, b) => {
    const tierDiff = getResultTier(a.url) - getResultTier(b.url)
    if (tierDiff !== 0) return tierDiff
    if (a.contentPriority !== b.contentPriority) return a.contentPriority - b.contentPriority
    const aStandalone = isStandaloneArticle(a.title, artistQuery) ? 0 : 1
    const bStandalone = isStandaloneArticle(b.title, artistQuery) ? 0 : 1
    if (aStandalone !== bStandalone) return aStandalone - bStandalone
    const dateA = a.publishedDate ? new Date(a.publishedDate).getTime() : 0
    const dateB = b.publishedDate ? new Date(b.publishedDate).getTime() : 0
    return dateB - dateA
  })

  // Pick up to 3 results, one per registrable domain (avoids e.g. 3 Hyperallergic pieces)
  const seenDomains = new Set<string>()
  const top3: typeof valid = []
  for (const r of valid) {
    const domain = registrableDomain(r.url)
    if (!seenDomains.has(domain)) {
      seenDomains.add(domain)
      top3.push(r)
      if (top3.length === 3) break
    }
  }
  const prereads = top3.map(toPrereadRow)

  console.log(`Exa selected [${showTitle}]:`, prereads.map((p) => ({ title: p.article_title, pub: p.publication, url: p.article_url })))

  return { prereads, hasShowCoverage: valid.some((r) => r.contentPriority === 0) }
}

// ─── Location filter (Req #2) ─────────────────────────────────────────────────
// Batch-classifies extracted links as 'nyc' or 'other' using a cheap Haiku call.
// Catches gallery shows at fairs, biennials, or partner venues in other cities.

export async function filterLinksByLocation(
  links: ExhibitionLink[],
  institutionName: string
): Promise<ExhibitionLink[]> {
  if (links.length === 0) return []

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `For each exhibition from ${institutionName}'s website, determine whether it takes place at their primary New York City location or somewhere clearly outside NYC.

Return ONLY a JSON array (no markdown):
[{"url":"...","location":"nyc","location_note":"..."}]

Use "other" ONLY when the title or URL names a specific place outside NYC (e.g. Venice Biennale, Art Basel Miami, London, Paris, LA).
Use "nyc" for everything else, including community/partner/education programs, teen or outreach initiatives, and any name that merely sounds like it could involve another site without naming one — these are frequently presented at the institution's own NYC building. Default to "nyc" whenever there's no explicit non-NYC place name.

Exhibitions:
${JSON.stringify(links.map((l) => ({ url: l.url, title: l.title })))}`,
      },
    ],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  try {
    const classified = extractJsonArray<{
      url: string; location: string; location_note?: string
    }>(text)
    if (!classified) return links

    const byUrl = new Map(classified.map((c) => [c.url, c]))

    return links.filter((link) => {
      const result = byUrl.get(link.url)
      if (!result) return true  // not in response → keep (fail open)
      if (result.location === 'other') {
        console.log(`[Location] Excluded "${link.title}": ${result.location_note ?? 'non-NYC'}`)
        return false
      }
      return true
    })
  } catch {
    console.error('filterLinksByLocation: failed to parse response — keeping all links')
    return links
  }
}

// ─── Title hallucination check (Req #1) ──────────────────────────────────────
// Called only when the fast string check in scraper.ts fails.
// Haiku verifies whether the title appears near-verbatim on the rendered page.

export async function verifyTitleInHtml(title: string, html: string): Promise<boolean> {
  const pageText = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 8000)

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 5,
    messages: [
      {
        role: 'user',
        content: `Does the text "${title}" appear verbatim or near-verbatim in the following page content? Answer only "yes" or "no".\n\n${pageText}`,
      },
    ],
  })

  const answer = response.content.find((b) => b.type === 'text')?.text?.toLowerCase().trim() ?? 'no'
  return answer.startsWith('yes')
}

// ─── Step 1: listing page link extraction ─────────────────────────────────────

function resolveUrl(href: string, base: string): string {
  try { return new URL(href, base).href } catch { return href }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // <meta name="description">/og:description are frequently pre-truncated by the
    // site itself (e.g. ending in "…") for social-sharing snippets — leaving them
    // in tempts extraction into grabbing the short truncated version instead of
    // the full text that's actually in the page body.
    .replace(/<meta\b[^>]*>/gi, '')
}

// Extracts Next.js __NEXT_DATA__ from raw HTML and returns a CLEAN summary of key fields.
// Used when the DOM shell is empty (pure CSR apps where React hasn't hydrated).
// Rather than slicing the raw JSON (which may contain unescaped quotes or 600K of block data),
// we parse the JSON and extract only the fields Claude needs for detail extraction.
function extractNextJsData(html: string): string | null {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i)
  if (!match) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = JSON.parse(match[1]) as any
    const tqd = data?.props?.pageProps?.__TEMPLATE_QUERY_DATA__
    const ex = tqd?.exhibition ?? tqd
    if (!ex) return null
    // Sanitize text fields that may contain HTML or smart quotes — Claude echoes these
    // verbatim in its response JSON, normalizing smart quotes to ASCII, which breaks JSON.parse.
    const sanitize = (s: string | null | undefined): string | null => {
      if (!s) return null
      return s
        .replace(/<[^>]+>/g, '')              // strip HTML tags
        .replace(/[\u201c\u201d]/g, "'")  // curly double quotes -> single quote (ASCII double would break Claude JSON output)
        .replace(/[\u2018\u2019]/g, "'")  // curly single quotes -> ASCII straight apostrophe
        .trim()
    }
    const summary = {
      title: ex?.seo?.opengraphTitle ?? ex?.seo?.title?.replace(/\s*-\s*[^-]+$/, '') ?? null,
      exhibitionIntro: sanitize(ex?.exhibitionIntro),
      startDate: ex?.startDate ?? null,
      endDate: ex?.endDate || null,
      dateTextOverride: ex?.dateTextOverride ?? null,
      imageUrl: ex?.heroAsset?.desktop?.sourceUrl ?? null,
      seoDescription: sanitize(ex?.seo?.metaDesc),
    }
    return JSON.stringify(summary)
  } catch {
    // Fallback: return raw slice for sites with non-standard structure
    return match[1].slice(0, 30000)
  }
}

// Aggressively strips scripts, styles, JSON-LD blobs, and HTML comments
// before passing to Claude — removes bloat that pushes real content past the slice window
function deepStripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    // <meta name="description">/og:description are frequently pre-truncated by the
    // site itself (e.g. ending in "…") for social-sharing snippets — leaving them
    // in tempts extraction into grabbing the short truncated version instead of
    // the full text that's actually in the page body.
    .replace(/<meta\b[^>]*>/gi, '')
}

// For detail page retry: focus on semantic content containers
// before trying the full page. Handles sites where content is in
// non-standard or deeply nested containers.
function extractDetailFocused(html: string): string {
  const patterns = [
    /<article[\s\S]*?<\/article>/i,
    /<[^>]+class="[^"]*(?:exhibition|detail|show|content|entry|post)[^"]*"[\s\S]*?<\/(?:div|section|main|article)>/i,
    /<main[\s\S]*?<\/main>/i,
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m[0].length > 1000) return m[0]
  }
  return html
}

// Extract the main content region of a page to avoid wasting token budget on
// nav/header/footer/sidebar boilerplate. Falls back to the full stripped HTML.
function extractMainContent(html: string): string {
  const stripped = stripHtml(html)
  // Try semantic main content containers in priority order
  const patterns = [
    /<main[\s\S]*?<\/main>/i,
    /<[^>]+role=["']main["'][\s\S]*?>/i,
    /<article[\s\S]*?<\/article>/i,
    /<[^>]+id=["'](?:main-content|content|main)["'][\s\S]*?>/i,
  ]
  for (const re of patterns) {
    const m = stripped.match(re)
    if (m && m[0].length > 1000) return m[0]
  }
  return stripped
}

// Listing pages are dominated by nav/footer/repeated-card boilerplate that has
// nothing to do with classification — on a large museum page, real exhibition
// links can be a rounding error of the total markup. Rather than paying to send
// (and truncating) the whole page, pull out just each same-domain <a href> plus
// a window of surrounding text (title/date/label context usually lives right
// next to the link in the DOM). Cost then scales with the number of links on
// the page, not the page's total size.
function extractAnchorContext(html: string, baseUrl: string, contextChars = 600): string {
  const baseHost = (() => {
    try { return new URL(baseUrl).hostname.replace(/^www\./, '') } catch { return null }
  })()

  const headingRe = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi
  const headings: string[] = []
  let hm: RegExpExecArray | null
  while ((hm = headingRe.exec(html)) !== null) {
    const text = hm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text) headings.push(text)
  }
  const headingBlock = headings.length
    ? `Section headings on this page, in document order: ${headings.join(' | ')}\n\n`
    : ''

  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi
  const ranges: [number, number][] = []
  let am: RegExpExecArray | null
  while ((am = anchorRe.exec(html)) !== null) {
    const href = am[1]
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue
    if (/^https?:\/\//i.test(href) && baseHost) {
      try {
        if (new URL(href).hostname.replace(/^www\./, '') !== baseHost) continue
      } catch { continue }
    }
    ranges.push([
      Math.max(0, am.index - contextChars),
      Math.min(html.length, am.index + am[0].length + contextChars),
    ])
  }

  if (ranges.length === 0) return headingBlock + html.slice(0, 60000)

  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = [ranges[0]]
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1]
    if (start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }

  return headingBlock + merged.map(([start, end]) => html.slice(start, end)).join('\n<!-- ... -->\n')
}

export async function extractExhibitionLinks(
  html: string,
  venueName: string,
  venueUrl: string
): Promise<ExhibitionLink[]> {
  const today = new Date().toISOString().split('T')[0]
  const stripped = extractAnchorContext(extractMainContent(html), venueUrl).slice(0, 100000)

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `Extract all exhibition links from this ${venueName} listing page (${venueUrl}).

Today: ${today}

For each exhibition link found, return:
- title: the exhibition or show title
- url: full absolute URL to the exhibition detail page (resolve relative URLs against base ${venueUrl})
- classification_reason: work through the evidence first (section heading, labels, explicit dates compared to today) — brief note (e.g. "labeled On View", "end date passed", "section heading: Past")
- classification: exactly one of 'current' | 'past' | 'permanent' | 'upcoming', consistent with the reasoning above
- content_type: exactly one of 'exhibition' | 'event' | 'online_only' | 'unclear'

Classification rules:
- "On View", "Current", "Now On View" → 'current'
- "Past", "Archive", "Previous" → 'past'
- "Permanent Collection", "The Collection" → 'permanent'
- "Upcoming", "Coming Soon", "Opening Soon" → 'upcoming'
- Date range end before today → 'past'
- Date range start after today → 'upcoming'
- URL patterns: /current/ or /on-view/ → 'current'; /past/ or /archive/ → 'past'
- When ambiguous: default to 'current'

Content type rules:
- 'exhibition': a physical exhibition of artwork on view at the institution's OWN physical gallery/museum space
- 'event': artist talks, panel discussions, members' events, tours, workshops, screenings, performances, off-site public art commissions, community initiatives, or anything the site itself labels as a "Project", "Program", "Initiative", or similar (as opposed to "Exhibition") — even if it has a real artist name, real dates, and a real image. Institutions often list these alongside real exhibitions under section headings like "Beyond Our Walls", "Museum Projects", "Public Programs", or "Community" — these are NOT exhibitions regardless of how exhibition-like their listing card looks.
- 'online_only': viewing rooms, digital exhibitions, or online-only content with no physical component
- 'unclear': cannot determine content type from the listing page alone
- When ambiguous between 'exhibition' and something else: use 'unclear', not 'exhibition'
- Trust the site's own labeling/section headings over the presence of exhibition-like details (artist name, dates, image) — a card labeled "Project" with a real artist and real dates is still not an exhibition

Return ONLY a JSON array (no markdown, no commentary):
[{"title":"...","url":"https://...","classification_reason":"...","classification":"current","content_type":"exhibition"}]

Return [] if no exhibition links are found.

HTML:
${stripped}`,
      },
    ],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  try {
    const raw = extractJsonArray<{
      title?: string; url?: string
      classification?: string; classification_reason?: string
      content_type?: string
    }>(text)
    if (!raw) return []
    return raw
      .filter((item) => item.title && item.url)
      .map((item) => ({
        title: item.title!,
        url: resolveUrl(item.url!, venueUrl),
        classification: (['current','past','permanent','upcoming'].includes(item.classification ?? '')
          ? item.classification
          : 'current') as ExhibitionLink['classification'],
        classification_reason: item.classification_reason ?? '',
        content_type: (['exhibition','event','online_only','unclear'].includes(item.content_type ?? '')
          ? item.content_type
          : 'unclear') as ExhibitionLink['content_type'],
      }))
  } catch {
    console.error(`Failed to parse exhibition links JSON for ${venueName}:`, text.slice(0, 200))
    return []
  }
}

// Classify a list of candidate URLs by exhibition status — used as a fallback
// when extractExhibitionLinks finds 0 links (e.g. content past the slice window).
// Claude infers classification from URL path and naming conventions only.
// Batch size kept small enough that a chunk's JSON response (url/title/reason/classification
// per item) can't get cut off by max_tokens — a 60-80 URL single call was truncating silently.
const CLASSIFY_CHUNK_SIZE = 20

async function classifyExhibitionUrlChunk(
  urls: string[],
  venueName: string,
  venueUrl: string
): Promise<ExhibitionLink[]> {
  const today = new Date().toISOString().split('T')[0]

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Classify these ${venueName} exhibition URLs as current, upcoming, past, or permanent.

Today: ${today}
Base: ${venueUrl}

Infer from URL path and slug only (no page content available).
Default to "current" when uncertain — downstream temporal validation will discard past shows.

Return ONLY a JSON array:
[{"url":"https://...","title":"human-readable name from URL slug","classification_reason":"...","classification":"current"|"upcoming"|"past"|"permanent"}]

URLs:
${urls.join('\n')}`,
    }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  try {
    const raw = extractJsonArray<{
      url?: string; title?: string; classification?: string; classification_reason?: string
    }>(text)
    if (!raw) {
      console.warn(`[classifyExhibitionUrls] Failed to parse JSON for ${venueName} (${urls.length} URLs, stop_reason: ${response.stop_reason}). Response preview: ${text.slice(0, 300)}`)
      return []
    }
    return raw
      .filter((item) => item.url && item.title)
      .map((item) => ({
        title: item.title!,
        url: resolveUrl(item.url!, venueUrl),
        classification: (['current','past','permanent','upcoming'].includes(item.classification ?? '')
          ? item.classification
          : 'current') as ExhibitionLink['classification'],
        classification_reason: item.classification_reason ?? 'href scan fallback',
        // No page content available in this URL-only fallback — can't judge content type, so
        // give benefit of the doubt rather than risk silently discarding a real exhibition.
        content_type: 'unclear' as ExhibitionLink['content_type'],
      }))
  } catch (err) {
    console.warn(`[classifyExhibitionUrls] Exception parsing response for ${venueName} (${urls.length} URLs, stop_reason: ${response.stop_reason}):`, err instanceof Error ? err.message : err)
    return []
  }
}

export async function classifyExhibitionUrls(
  urls: string[],
  venueName: string,
  venueUrl: string
): Promise<ExhibitionLink[]> {
  if (urls.length === 0) return []

  const chunks: string[][] = []
  for (let i = 0; i < urls.length; i += CLASSIFY_CHUNK_SIZE) {
    chunks.push(urls.slice(i, i + CLASSIFY_CHUNK_SIZE))
  }

  const results = await Promise.all(
    chunks.map((chunk) => classifyExhibitionUrlChunk(chunk, venueName, venueUrl))
  )
  return results.flat()
}

// ─── Step 2: detail page extraction ──────────────────────────────────────────

const EMPTY_DETAIL: ExhibitionDetailExtracted = {
  title: null, artists: [], start_date: null, end_date: null,
  date_notes: null, description: null, image_url: null, press_release_url: null,
  show_type: 'exhibition',
}

function normalizeShowType(value: unknown): ExhibitionDetailExtracted['show_type'] {
  return value === 'installation' ? 'installation' : 'exhibition'
}

const DETAIL_PROMPT = (url: string, content: string) => `Extract exhibition data from this page (${url}).

Today: ${new Date().toISOString().split('T')[0]}

CRITICAL RULES:
- Do NOT generate, infer, or hallucinate content not present on the page
- description must be verbatim extracted text — never AI-generated or summarized
- If a field is not on the page, return null
- Dates in YYYY-MM-DD format only
- When a date on the page has no explicit year (e.g. "Through Jul 25", "Opens March 3"), this is a listing of what the institution currently considers on view — infer the year that is consistent with that: for an end date, pick the soonest occurrence of that month/day that is on or after today; for a start date, pick the occurrence that keeps the exhibition's run plausible relative to today. Do not default to the current calendar year or the page's copyright year without this reasoning — a bare "Jul 25" read on a page today should not be assumed to have already passed just because that date earlier this year is in the past.
- The output must be valid JSON: any double-quote character that is part of extracted text (e.g. a quoted phrase copied from the page) must be escaped as \\" so it does not terminate the JSON string early
- show_type: "installation" when the page describes a site-specific, long-term, permanent, or on-view-indefinitely work/display (e.g. "long-term view", "permanent installation", "on view indefinitely", a commissioned site-specific work) — "exhibition" for a normal temporary show with a defined or expected run. Default to "exhibition" when unclear.

Return ONLY a JSON object (no markdown, no commentary):
{
  "title": "exhibition title or null",
  "artists": ["artist name strings — empty array if none"],
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null",
  "date_notes": "verbatim date text that could not be parsed as YYYY-MM-DD (e.g. 'On view through summer 2025') — null if dates were fully parsed or no date info exists",
  "description": "full verbatim exhibition description or press release text — take the longest body of text about the show, do not truncate, do not summarize — null if nothing found on page",
  "image_url": "absolute URL of primary exhibition image — prefer hero/banner or og:image meta, not thumbnails/icons/logos — null if none",
  "press_release_url": "URL to a separate press release PDF or page if explicitly linked — null otherwise",
  "show_type": "exhibition" | "installation"
}

HTML:
${content}`

// Dedicated extractor for Next.js __NEXT_DATA__ JSON blobs.
// Uses a targeted prompt to reliably extract from the JSON field structure
// without confusing exhibition title with location data.
async function callClaudeForNextData(nextDataJson: string, url: string): Promise<ExhibitionDetailExtracted> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Extract exhibition data from this Next.js page data JSON for ${url}.

Use these exact JSON fields (paths within the JSON):
- title → seo.opengraphTitle verbatim (e.g. "Facade: Tschabalala Self—Art Lovers" or "New Humans: Memories of the Future"). This is the COMPLETE official exhibition title — do not shorten or strip any part of it.
- artists → infer from the title text (typically the name after "—" dash, or the whole title if no dash)
- start_date → parse startDate ISO string to YYYY-MM-DD, or null
- end_date → parse endDate ISO string to YYYY-MM-DD, or null if field is empty/missing
- description → exhibitionIntro field text verbatim (or seo.metaDesc if exhibitionIntro absent)
- image_url → heroAsset.desktop.sourceUrl (absolute https:// URL)
- press_release_url → null
- show_type → "installation" if the title/description indicates a long-term, permanent, or site-specific installation rather than a temporary show; "exhibition" otherwise (default)

The output must be valid JSON: any double-quote character that is part of extracted text (e.g. a quoted phrase copied verbatim) must be escaped as \\" so it does not terminate the JSON string early.

Return ONLY a JSON object:
{"title":"...","artists":["..."],"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD or null","date_notes":null,"description":"...","image_url":"https://...","press_release_url":null,"show_type":"exhibition"}

JSON data:
${nextDataJson}`,
    }],
  })
  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  const raw = extractJsonObject<Partial<ExhibitionDetailExtracted>>(text)
  if (!raw) return EMPTY_DETAIL
  return {
    title: raw.title ?? null,
    artists: Array.isArray(raw.artists) ? raw.artists.filter(Boolean) : [],
    start_date: raw.start_date ?? null,
    end_date: raw.end_date ?? null,
    date_notes: raw.date_notes ?? null,
    description: raw.description ?? null,
    image_url: raw.image_url ?? null,
    press_release_url: raw.press_release_url ?? null,
    show_type: normalizeShowType(raw.show_type),
  }
}

async function callClaudeForDetail(content: string, url: string): Promise<ExhibitionDetailExtracted> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: DETAIL_PROMPT(url, content) }],
  })
  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  const raw = extractJsonObject<Partial<ExhibitionDetailExtracted>>(text)
  if (!raw) {
    console.error(`Failed to parse exhibition detail JSON for ${url}:`, text.slice(0, 200))
    return EMPTY_DETAIL
  }
  return {
    title: raw.title ?? null,
    artists: Array.isArray(raw.artists) ? raw.artists.filter(Boolean) : [],
    start_date: raw.start_date ?? null,
    end_date: raw.end_date ?? null,
    date_notes: raw.date_notes ?? null,
    description: raw.description ?? null,
    image_url: raw.image_url ?? null,
    press_release_url: raw.press_release_url ?? null,
    show_type: normalizeShowType(raw.show_type),
  }
}

// Sanity ceiling for the expanded-window retry below — comfortably above every
// real page's main-content size observed in practice (up to ~400KB raw, less
// after stripping), while still bounding worst-case cost on a pathological page.
const MAX_DETAIL_CONTENT_LENGTH = 400000

// A description this short is either a genuinely terse blurb or (far more often
// in practice) a fragment that got cut off mid-paragraph by the character window
// — a portion of the press release captured, not all of it. There's no reliable
// way to tell those apart from the text alone, so this threshold is a judgment
// call, not a hard signal; tune if it over- or under-triggers in practice.
const MIN_COMPLETE_DESCRIPTION_LENGTH = 200

function descriptionLooksIncomplete(detail: ExhibitionDetailExtracted): boolean {
  return (detail.description?.trim().length ?? 0) < MIN_COMPLETE_DESCRIPTION_LENGTH
}

export async function extractExhibitionDetail(
  html: string,
  exhibitionUrl: string
): Promise<ExhibitionDetailExtracted> {
  // Deep strip removes scripts, styles, JSON-LD blobs, and HTML comments
  // before slicing — clears bloat that pushes real content past the window
  const cleaned = deepStripHtml(html)
  const mainContent = extractMainContent(cleaned)
  const primary = mainContent.slice(0, 60000)

  let result = await callClaudeForDetail(primary, exhibitionUrl)

  // If title is null, retry targeting specific semantic containers —
  // handles sites where the exhibition data is in a non-standard wrapper
  if (!result.title?.trim()) {
    const focused = extractDetailFocused(cleaned).slice(0, 60000)
    if (focused.length > 1000 && focused !== primary) {
      console.log(`[extractExhibitionDetail] title null on first pass — retrying with focused content (${exhibitionUrl})`)
      const retry = await callClaudeForDetail(focused, exhibitionUrl)
      if (retry.title?.trim()) result = retry
    }

    // Last resort: try __NEXT_DATA__ hydration JSON.
    // Covers (a) pure CSR shells with empty DOM after script strip, and
    // (b) rendered Next.js pages whose template structure doesn't match our
    // extractMainContent patterns (e.g. Frick's "on view" show template).
    if (!result.title?.trim()) {
      const nextData = extractNextJsData(html)
      if (nextData) {
        console.log(`[extractExhibitionDetail] both passes failed — trying __NEXT_DATA__ (${exhibitionUrl})`)
        const nextResult = await callClaudeForNextData(nextData, exhibitionUrl)
        try {
          const diag = JSON.stringify({ tag: 'AGENT1', url: exhibitionUrl, event: 'NEXT_DATA_RESULT', title_found: nextResult.title?.trim() || null })
          ;(await import('fs')).appendFileSync('/tmp/scrape-diag.jsonl', diag + '\n')
        } catch {}
        if (nextResult.title?.trim()) result = nextResult
      }
    }
  }

  // Title came through fine, but the description looks empty or cut off — and
  // there's more real content beyond the 60K window we already sent. The
  // character limit is the likely cause here, not the model choosing to omit
  // it, so retry once with the full page content instead of a fixed window.
  if (result.title?.trim() && descriptionLooksIncomplete(result) && mainContent.length > primary.length) {
    const expanded = mainContent.slice(0, MAX_DETAIL_CONTENT_LENGTH)
    console.log(`[extractExhibitionDetail] description incomplete on first pass (${result.description?.length ?? 0} chars) — retrying with expanded window (${expanded.length} chars) for ${exhibitionUrl}`)
    const expandedResult = await callClaudeForDetail(expanded, exhibitionUrl)
    const expandedLen = expandedResult.description?.trim().length ?? 0
    const currentLen = result.description?.trim().length ?? 0
    if (expandedResult.title?.trim() && expandedLen > currentLen) {
      result = expandedResult
    }
  }

  return result
}
