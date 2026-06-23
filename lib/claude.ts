import Anthropic from '@anthropic-ai/sdk'
import Exa from 'exa-js'
import { getSupabaseAdmin } from './supabase'
import type { ExhibitionRaw, Preread } from './types'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

const BETA_HEADERS = { 'anthropic-beta': 'prompt-caching-2024-07-31' }

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
Artists as an array of strings.`,
  cache_control: { type: 'ephemeral' },
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”')
    .replace(/&ldquo;/g, '“')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
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

  try {
    const jsonMatch = lastText.text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []
    return JSON.parse(jsonMatch[0]) as ExhibitionRaw[]
  } catch {
    console.error(`Failed to parse exhibitions JSON for ${venueName}:`, lastText.text.slice(0, 200))
    return []
  }
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
