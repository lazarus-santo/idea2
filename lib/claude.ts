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

export function extractJsonArray<T = unknown>(text: string): T[] | null {
  return scanBalancedJson<T[]>(text, '[', ']')
}

export function extractJsonObject<T = unknown>(text: string): T | null {
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
// nytimes.com, theguardian.com, and wsj.com are blocked from Exa's `includeDomains`
// on this plan — a domain-filtered search naming any of them throws a 403 for the
// whole request, not just an empty result for that domain (verified directly).
// TIER_2_DOMAINS itself stays as the classification list for getResultTier (fine to
// classify a result as Tier 2 if it shows up via an unfiltered search) — this subset
// is for any search that actually passes `includeDomains` to Exa.
const EXA_QUERYABLE_TIER_2_DOMAINS = TIER_2_DOMAINS.filter(
  (d) => !['nytimes.com', 'theguardian.com', 'wsj.com'].includes(d)
)
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
  'news.artnet.com': 'Artnet News',
}

export function getResultDomain(url: string): string {
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsWholeWord(text: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(text)
}

function significantNameParts(name: string): string[] {
  return name.split(/[\s,]+/).filter((p) => p.length > 2)
}

// Hard relevance filter — an article must actually be about THIS artist, not just
// share a name fragment with them. Requires every significant part of their name
// (whole-word match, not substring) to appear somewhere in the title or highlights.
// A single shared part isn't enough: a "Naomi Klein" op-ed won't also contain "Yves",
// so an "Yves Klein" search correctly rejects it even though both share "Klein".
// Deliberately name-only — no genre/keyword check — so crossover artists (e.g. a
// visual artist also covered as a musician) aren't penalized for not reading as "art press."
//
// This is intentionally weak for a single-word (mononym) name — every article that
// mentions "Klein" passes, including ones about a different Klein entirely. That's a
// known gap; see isSignificantlyAmbiguous / verifyMononymCandidates below, which handle
// disambiguation for that case with an actual comprehension check instead of more
// keyword-matching (an earlier attempt at a keyword-based fix here kept surfacing new
// failure modes — e.g. misattributing a detail from someone else mentioned in the same
// press release — because keyword matching can't tell "about" from "mentions").
function isAboutArtist(result: PoolResult, artistName: string): boolean {
  const parts = significantNameParts(artistName)
  if (parts.length === 0) return true
  const text = [result.title ?? '', ...(result.highlights ?? [])].join(' ')
  return parts.every((p) => containsWholeWord(text, p))
}

type CandidateContentType = 'interview' | 'profile' | 'review' | 'news' | 'other'
type CandidateSourceType = 'editorial' | 'venue' | 'self' | 'listing' | 'other'

interface VerifiedCandidate {
  substantiallyAbout: boolean
  contentType: CandidateContentType
  sourceType: CandidateSourceType
}

// The storage gate: a candidate must be genuinely about the subject AND come from an
// actual editorial publication. Domain heuristics can't reliably catch non-press
// sources — proven live: a representing gallery's own artist page ("Sawako Goda |
// Nonaka-Hill"), a museum's event listing ("Riobamba | Activity | MACBA"), and a
// directory profile ("Michele Cesaratto | HENI News Profile") all passed every
// domain/name/aboutness check, because they ARE about the right artist — they're just
// not press. Candidates that fail this gate are dropped entirely, even if that leaves
// fewer results than the cap (or none): a sparse-but-real preread list beats a padded
// one. Fails open only when verification itself errored (v missing), matching the
// existing fail-open behavior for API errors.
function passesQualityGate(v: VerifiedCandidate | undefined): boolean {
  if (!v) return true
  return v.substantiallyAbout && v.sourceType === 'editorial'
}

// Direct comprehension check, run unconditionally on every candidate pool (not just
// name-ambiguous artists) — keyword/name-presence matching alone can't tell "genuinely
// about X" from "X gets a passing mention in something bigger." Concretely proven live:
// an Artforum events index page and a Frieze "5 themes" multi-artist roundup both
// legitimately contained an artist's name in their highlights and passed a pure
// name-presence check, despite neither being an article about that artist. Reasons from
// the actual source text every time rather than a pre-extracted phrase that can go stale
// or misattribute a detail about someone else in the same source. `sourceText` — an
// artist's bio, or an exhibition's press release — grounds the "same entity, not a
// namesake" half of the check when available; the "substantially about, not incidental"
// half works even without it, from the candidates' own title/highlight alone.
//
// Also classifies each candidate's content type in the same call (no extra cost) — added
// after a live case where a search explicitly intended to find an interview/profile
// (searchArtistProfile's own query says so) instead picked an album review over an
// available interview, purely because both were Tier 3 and the review was 4 days more
// recent. Tier/recency alone can't express "this search wanted an interview."
//
// Returns a map from URL to verification result; on any failure (parse failure, API
// error) marks every candidate as substantially-about with contentType 'other' rather
// than over-rejecting — callers that don't care about content type can ignore that field.
async function verifySubstantiallyAbout(
  subjectLabel: string,
  sourceText: string | null,
  candidates: (PoolResult & { title: string })[]
): Promise<Map<string, VerifiedCandidate>> {
  const fallback = new Map(candidates.map((c) => [c.url, { substantiallyAbout: true, contentType: 'other' as CandidateContentType, sourceType: 'editorial' as CandidateSourceType }]))
  if (candidates.length === 0) return fallback

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `${sourceText ? `The following text describes ${subjectLabel}:\n\n${sourceText.slice(0, 3000)}\n\n` : ''}Below are web search results that may or may not be genuinely, substantially about ${subjectLabel}.

Reject a result (substantially_about: false) if any of these apply:
- It's about a different, unrelated person or thing that merely shares a name (common names can belong to multiple people/things)
${sourceText ? `- It's actually about someone else mentioned in the background text above (e.g. a collaborator, curator, or character), not ${subjectLabel} themself\n` : ''}- It only mentions ${subjectLabel} in passing, as one of many in a broader event listing, index/category page, group roundup, or multi-subject survey, rather than being substantially about them specifically

For every result, also classify its content_type as one of: "interview" (a direct Q&A or conversation with the subject), "profile" (a feature/biographical piece primarily about the subject, not structured as Q&A), "review" (a review of a specific work — an album, show, book, film, etc.), "news" (a news/announcement item), or "other".

For every result, also classify its source_type — judge from the URL's domain/path and the title, e.g. a title like "Artist Name | Gallery Name" or a URL path like /artists/ or /activity/ signals a venue or listing page, not an article:
- "editorial": an article published by a news outlet, magazine, journal, radio/culture site, or independent editorial blog — someone writing ABOUT the subject as press
- "venue": a gallery's, museum's, or institution's own website — artist roster pages, exhibition pages, event listings, program pages, or press releases they host themselves
- "self": the subject's own website, label/artist page, online store, streaming or social profile
- "listing": a directory, database, aggregator, ticketing, retail, or index page
- "other": anything else

Results:
${JSON.stringify(candidates.map((c) => ({ url: c.url, title: c.title, highlight: c.highlights?.[0] ?? '' })))}

Return ONLY a JSON array, one entry per result:
[{"url": "...", "substantially_about": true, "content_type": "interview", "source_type": "editorial"}]`,
    }],
  }).catch(() => null)

  if (!response) return fallback
  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  const parsed = extractJsonArray<{ url: string; substantially_about: boolean; content_type?: string; source_type?: string }>(text)
  if (!parsed) return fallback

  const result = new Map<string, VerifiedCandidate>()
  for (const p of parsed) {
    const contentType: CandidateContentType =
      (['interview', 'profile', 'review', 'news'] as const).includes(p.content_type as 'interview' | 'profile' | 'review' | 'news')
        ? (p.content_type as CandidateContentType)
        : 'other'
    const sourceType: CandidateSourceType =
      (['editorial', 'venue', 'self', 'listing'] as const).includes(p.source_type as 'editorial' | 'venue' | 'self' | 'listing')
        ? (p.source_type as CandidateSourceType)
        : 'other'
    result.set(p.url, { substantiallyAbout: !!p.substantially_about, contentType, sourceType })
  }
  return result
}

function isBlockedUrl(url: string, galleryDomains: Set<string>): boolean {
  const host = getResultDomain(url)
  if (host.includes('wikipedia.org')) return true
  if (host.includes('substack.com')) return true
  if (host.includes('linkedin.com')) return true
  if (isArtsyArtistPage(url)) return true
  if (galleryDomains.has(registrableDomain(url))) return true
  if (GALLERY_HOSTNAME_RE.test(host)) return true
  return false
}

// Subdomains that are infrastructure, not the publication name itself.
const STRIP_SUBDOMAIN_RE = /^(www|shop|blog|store|news|press|web|m|app|media)\./i

export function publicationFromUrl(url: string): string | null {
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

type GalleryShowType = 'solo' | 'small_group' | 'large_group'

function classifyGalleryShow(artistCount: number): GalleryShowType {
  if (artistCount <= 1) return 'solo'
  if (artistCount <= 5) return 'small_group'
  return 'large_group'
}

// Runs the shared "show review" search used by both group tiers: a single,
// once-per-show query (not per-artist), domain-filtered to major press first,
// falling back to an unfiltered retry when the filtered pool is too thin. Unlike the
// per-artist search, this had NO relevance check at all before — proven live to matter:
// an unrelated New Yorker piece won a group show's review slot purely for being a
// Tier-2 domain result, with nothing checking it was actually about the show.
async function searchShowReview(
  exa: Exa,
  showTitle: string,
  venueName: string,
  isValid: (r: PoolResult) => r is PoolResult & { title: string },
  wantCount: number,
  minDomainFilteredResults: number,
  pressRelease: string | null
): Promise<(PoolResult & { title: string })[]> {
  const query = `${showTitle} ${venueName} review exhibition 2025 OR 2026`

  const filtered = await exa.search(query, {
    type: 'auto',
    numResults: 5,
    includeDomains: EXA_QUERYABLE_TIER_2_DOMAINS,
    contents: { highlights: true },
  }).catch(() => ({ results: [] as unknown[] }))

  let candidates = sortByTierAndRecency((filtered.results as unknown as PoolResult[]).filter(isValid))

  if (candidates.length < minDomainFilteredResults) {
    console.log(`Exa show-review [${showTitle}]: only ${candidates.length} domain-filtered result(s) (need ${minDomainFilteredResults}) — retrying without domain filter`)
    const unfiltered = await exa.search(query, {
      type: 'auto',
      numResults: 5,
      contents: { highlights: true },
    }).catch(() => ({ results: [] as unknown[] }))

    const seen = new Set(candidates.map((r) => r.url))
    const extra = (unfiltered.results as unknown as PoolResult[]).filter(isValid).filter((r) => !seen.has(r.url))
    candidates = sortByTierAndRecency([...candidates, ...extra])
  } else {
    console.log(`Exa show-review [${showTitle}]: ${candidates.length} domain-filtered result(s) — no retry needed`)
  }

  if (candidates.length > 0) {
    const verified = await verifySubstantiallyAbout(`the exhibition "${showTitle}" at ${venueName}`, pressRelease, candidates)
    candidates = candidates.filter((r) => passesQualityGate(verified.get(r.url)))
  }

  return candidates.slice(0, wantCount).map((r) => ({ ...r, contentPriority: 0 as const }))
}

// Single artist profile/interview search, no domain filter — shared by both group tiers.
// `disambiguator`, when present, is a short phrase (from the artist's bio, or the
// exhibition's press release as fallback) appended to the query to widen recall toward
// the right person — helpful even if imprecise, since the verification pass below (not
// this query) is what actually guarantees precision. `sourceText` is the artist's own
// bio when one exists, else the shared press release — passed through to that
// verification pass as the grounding text to reason against.
async function searchArtistProfile(
  exa: Exa,
  artistName: string,
  isValid: (r: PoolResult) => r is PoolResult & { title: string },
  disambiguator?: string,
  sourceText?: string | null
): Promise<(PoolResult & { title: string }) | null> {
  const query = disambiguator
    ? `${artistName} ${disambiguator} artist interview profile`
    : `${artistName} artist interview profile`

  const results = await exa.search(query, {
    type: 'auto',
    numResults: 5,
    contents: { highlights: true },
  }).catch(() => ({ results: [] as unknown[] }))

  let candidates = (results.results as unknown as PoolResult[]).filter(isValid).filter((r) => isAboutArtist(r, artistName))

  let verified = new Map<string, VerifiedCandidate>()
  if (candidates.length > 0) {
    verified = await verifySubstantiallyAbout(`the artist "${artistName}"`, sourceText ?? null, candidates)
    candidates = candidates.filter((r) => passesQualityGate(verified.get(r.url)))
  }

  // Tier still wins first — a Tier-1 review shouldn't lose to a random blog's interview.
  // But this search explicitly asks for "interview profile" content, so within the same
  // tier, prefer a genuine interview/profile match over e.g. an album review that merely
  // happens to be more recent. Proven live: a Pitchfork album review beat a Pitchfork
  // interview for Klein by 4 days, purely on recency, despite the interview being the
  // clearly better fit for a piece meant to introduce a reader to the artist.
  const CONTENT_TYPE_RANK: Record<CandidateContentType, number> = {
    interview: 0, profile: 0, review: 1, news: 2, other: 2,
  }
  const sorted = [...candidates].sort((a, b) => {
    const tierDiff = getResultTier(a.url) - getResultTier(b.url)
    if (tierDiff !== 0) return tierDiff
    const rankA = CONTENT_TYPE_RANK[verified.get(a.url)?.contentType ?? 'other']
    const rankB = CONTENT_TYPE_RANK[verified.get(b.url)?.contentType ?? 'other']
    if (rankA !== rankB) return rankA - rankB
    const dateA = a.publishedDate ? new Date(a.publishedDate).getTime() : 0
    const dateB = b.publishedDate ? new Date(b.publishedDate).getTime() : 0
    return dateB - dateA
  })
  return sorted[0] ? { ...sorted[0], contentPriority: 1 as const } : null
}

// Looks up any existing bios for these artists — populated by Agent 1 from a page's
// own "About the Artist" section (solo shows only; see scraper.ts). A bio is
// single-subject text, so it's a safer disambiguation source than a press release,
// which can describe other people too (collaborators, curators, characters).
async function fetchArtistBios(artistNames: string[]): Promise<Map<string, string>> {
  if (artistNames.length === 0) return new Map()
  const { data } = await getSupabaseAdmin().from('artists').select('name, bio').in('name', artistNames)
  const bios = new Map<string, string>()
  for (const row of data ?? []) {
    const bio = (row.bio as string | null)?.trim()
    if (bio) bios.set(row.name as string, bio)
  }
  return bios
}

// Extracts a disambiguating phrase for one artist from their own bio — single-subject
// text, so no misattribution risk, cheap Haiku call is reliable here. Asks for ALL
// distinctive roles, not just one — a single 2-5 word pick is a lottery on which facet
// of a multi-hyphenate gets mentioned, and that facet is what actually drives search
// recall. Proven live: Klein is genuinely a musician AND composer AND filmmaker, but a
// disambiguator that happened to land on "composer and artist based in London" (true,
// but missing "musician") meant Dazed and Vogue — outlets that frame her specifically as
// a musician — never surfaced in any query, run after run.
async function extractDisambiguatorFromBio(artistName: string, bio: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    messages: [{
      role: 'user',
      content: `From this artist bio, extract ALL distinctive roles or professions "${artistName}" is described as — every one stated or clearly implied, not just the single most prominent one. These will be used to help find them in a web search among unrelated people who happen to share their name.

Do NOT include generic words like "artist," "visual artist," "gallery," or "exhibition." Only include what's actually distinctive: other professions or mediums (e.g. "musician," "composer," "photographer," "filmmaker," "sculptor"), nationality, or a city they're based in. Use only what's stated or implied in the text — do not invent details.

Bio:
${bio.slice(0, 2000)}

Return ONLY a comma-separated list of the distinguishing terms, nothing else. If nothing distinctive is stated, return an empty string.`,
    }],
  }).catch(() => null)
  if (!response) return ''
  return response.content.find((b) => b.type === 'text')?.text?.trim() ?? ''
}

// Extracts a short disambiguating phrase per artist — from their own bio when one
// exists (safer, single-subject), falling back to the exhibition's shared press
// release for artists with no bio on file. Used to steer searches away from unrelated
// people who happen to share the artist's name. Falls back to no context for any
// artist with nothing usable found; callers must treat a missing entry as "search
// unmodified," never as an error.
async function extractArtistSearchContext(
  pressRelease: string | null,
  artistNames: string[],
  bios: Map<string, string>
): Promise<Map<string, string>> {
  const empty = new Map<string, string>()
  if (artistNames.length === 0) return empty

  const context = new Map<string, string>()

  const bioResults = await Promise.all(
    [...bios.entries()].map(async ([name, bio]) => [name, await extractDisambiguatorFromBio(name, bio)] as const)
  )
  for (const [name, phrase] of bioResults) {
    if (phrase) context.set(name, phrase)
  }

  const remaining = artistNames.filter((name) => !bios.has(name))
  if (remaining.length === 0 || !pressRelease?.trim()) return context

  // Sonnet, not Haiku — this needs to correctly track who a description's subject is
  // when a press release mentions multiple people (verified directly: Haiku misattributed
  // "the Canadian artist, LA Timpa" — someone else in the same sentence — to the artist
  // "Klein" even with explicit instructions not to; Sonnet got it right). One call per
  // exhibition, so the cost difference from Haiku is negligible.
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `From this exhibition press release, extract ALL distinctive roles or professions for each artist listed below — every one stated or clearly implied for that artist, not just the single most prominent one. A single pick is a lottery on which facet of a multi-hyphenate artist gets used, and that facet is what actually drives whether the right web search results get found later.

Press releases often mention OTHER people too — collaborators, curators, actors, or characters in a work. Only extract details stated about the named artist THEMSELF, never a detail that actually describes someone else mentioned in the text. Read carefully to confirm who a given description's subject really is before attributing it — do not assume the nearest adjective or nationality in the text belongs to the artist just because it appears near their name.

Do NOT include generic words like "artist," "visual artist," "gallery," or "exhibition" — everyone in this context is already an artist, so those words don't distinguish anyone. Only include what's actually distinctive: other professions or mediums (e.g. "musician," "composer," "photographer," "filmmaker," "sculptor"), nationality, a city they're based in, or similarly specific identifying details. Use only what's stated or clearly implied in the text — do not invent details, and do not guess if uncertain. If nothing distinctive and clearly-attributed is stated for an artist, use an empty string for them.

Artists: ${JSON.stringify(remaining)}

Press release:
${pressRelease.slice(0, 4000)}

Return ONLY a JSON object mapping each artist name to a comma-separated list of their distinguishing terms:
{"${remaining[0]}": "..."}`,
    }],
  }).catch(() => null)

  if (!response) return context
  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  const parsed = extractJsonObject<Record<string, string>>(text)
  if (!parsed) return context

  for (const name of remaining) {
    const phrase = parsed[name]?.trim()
    if (phrase) context.set(name, phrase)
  }
  return context
}

// Orders artists for Large Group per-artist search priority: artists without an
// existing bio on file first (higher information value to fill in), then alphabetical.
async function orderArtistsBySearchPriority(artistNames: string[]): Promise<string[]> {
  const { data } = await getSupabaseAdmin().from('artists').select('name, bio').in('name', artistNames)
  const hasBio = new Map((data ?? []).map((a) => [a.name as string, !!(a.bio as string | null)?.trim()]))
  return [...artistNames].sort((a, b) => {
    const aHasBio = hasBio.get(a) ?? false
    const bHasBio = hasBio.get(b) ?? false
    if (aHasBio !== bHasBio) return aHasBio ? 1 : -1
    return a.localeCompare(b)
  })
}

// ─── Small Group (2-5 artists) ─────────────────────────────────────────────
// 1 show-review result (once per show) + 1 per-artist result each, capped at 5
// stored total. If assembly exceeds the cap, the show-review result is kept and
// per-artist results are trimmed worst-tier-first.
async function generateSmallGroupPrereads(
  exa: Exa,
  exhibition: ExhibitionRaw & { venue_name: string },
  isValid: (r: PoolResult) => r is PoolResult & { title: string },
  context: Map<string, string>,
  bios: Map<string, string>
): Promise<GeneratePrereadsResult> {
  const showReview = await searchShowReview(exa, exhibition.show_title, exhibition.venue_name, isValid, 1, 1, exhibition.press_release)

  const perArtistResults = await Promise.all(
    exhibition.artists.map((artist) =>
      searchArtistProfile(exa, artist, isValid, context.get(artist), bios.get(artist) ?? exhibition.press_release)
    )
  )

  const seenUrls = new Set(showReview.map((r) => r.url))
  const perArtist: (PoolResult & { title: string })[] = []
  for (const result of perArtistResults) {
    if (!result || seenUrls.has(result.url)) continue
    seenUrls.add(result.url)
    perArtist.push(result)
  }

  let combined = [...showReview, ...perArtist]
  if (combined.length > 5) {
    const allowedPerArtist = Math.max(0, 5 - showReview.length)
    combined = [...showReview, ...sortByTierAndRecency(perArtist).slice(0, allowedPerArtist)]
  }

  console.log(`Exa selected [Small Group / ${exhibition.show_title}]:`, combined.map((r) => ({ title: r.title, url: r.url })))
  return { prereads: combined.map(toPrereadRow), hasShowCoverage: showReview.length > 0 }
}

// ─── Large Group (6+ artists) ───────────────────────────────────────────────
// Show-review search first (2-3 results), then per-artist searches fill any
// remaining slots up to a hard cap of 5 — stopping as soon as the cap is hit
// so searches never run for every artist in a large show.
async function generateLargeGroupPrereads(
  exa: Exa,
  exhibition: ExhibitionRaw & { venue_name: string },
  isValid: (r: PoolResult) => r is PoolResult & { title: string },
  context: Map<string, string>,
  bios: Map<string, string>
): Promise<GeneratePrereadsResult> {
  const showReview = await searchShowReview(exa, exhibition.show_title, exhibition.venue_name, isValid, 3, 2, exhibition.press_release)

  const seenUrls = new Set(showReview.map((r) => r.url))
  const rows: (PoolResult & { title: string })[] = [...showReview]

  if (rows.length < 5) {
    const orderedArtists = await orderArtistsBySearchPriority(exhibition.artists)
    for (const artist of orderedArtists) {
      if (rows.length >= 5) {
        console.log(`Exa per-artist [Large Group]: cap reached, skipping remaining artists (${orderedArtists.slice(orderedArtists.indexOf(artist)).join(', ')})`)
        break
      }
      const result = await searchArtistProfile(exa, artist, isValid, context.get(artist), bios.get(artist) ?? exhibition.press_release)
      console.log(`Exa per-artist [Large Group / ${artist}]:`, result ? { title: result.title, url: result.url } : 'no valid result')
      if (result && !seenUrls.has(result.url)) {
        seenUrls.add(result.url)
        rows.push(result)
      }
    }
  }

  console.log(`Exa selected [Large Group / ${exhibition.show_title}]:`, rows.map((r) => ({ title: r.title, url: r.url })))
  return { prereads: rows.slice(0, 5).map(toPrereadRow), hasShowCoverage: showReview.length > 0 }
}

export async function generatePrereads(
  exhibition: ExhibitionRaw & { venue_name: string }
): Promise<GeneratePrereadsResult> {
  const exa = new Exa(process.env.EXA_API_KEY!)
  const showTitle = exhibition.show_title
  const showType = classifyGalleryShow(exhibition.artists.length)

  // Build blocklist once — shared across all search paths
  const galleryDomains = await buildGalleryBlocklist()
  const isValid = (r: PoolResult): r is PoolResult & { title: string } =>
    !!r.title?.trim() && !isBlockedUrl(r.url, galleryDomains)

  // Bios (populated by Agent 1 from a page's own "About the Artist" section, solo
  // shows only) are a safer disambiguation source than the press release — single-
  // subject, no risk of misattributing a detail about someone else mentioned in the
  // same text. Fetched once and reused for both query-context extraction below and the
  // mononym verification pass further down.
  const bios = await fetchArtistBios(exhibition.artists)

  // One cheap call per exhibition, extracting a short disambiguating phrase per artist
  // (e.g. "musician and filmmaker") from their own bio when available, else the show's
  // shared press release — steers searches away from unrelated same-named people.
  // No-ops if nothing usable is found; every query below degrades gracefully.
  const searchContext = await extractArtistSearchContext(exhibition.press_release, exhibition.artists, bios)

  if (showType === 'small_group') {
    return generateSmallGroupPrereads(exa, exhibition, isValid, searchContext, bios)
  }

  if (showType === 'large_group') {
    return generateLargeGroupPrereads(exa, exhibition, isValid, searchContext, bios)
  }

  // ─── Solo path (1 artist) ─────────────────────────────────────────────────
  const artistQuery = exhibition.artists.join(', ')
  const disambiguator = searchContext.get(artistQuery)
  const artistQueryWithContext = disambiguator ? `${artistQuery} ${disambiguator}` : artistQuery

  // S1: broad recent coverage — not limited to interviews so reviews, essays, and features all qualify
  const search1 = await exa.search(`${artistQueryWithContext} artist`, {
    type: 'auto',
    numResults: 5,
    startPublishedDate: '2024-01-01',
    contents: { highlights: true },
  })
  console.log(`Exa S1 [${artistQueryWithContext}]:`, search1.results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate })))

  const search2 = await exa.search(`${artistQueryWithContext} artwork practice critical essay`, {
    type: 'auto',
    numResults: 5,
    startPublishedDate: '2022-01-01',
    contents: { highlights: true },
  })
  console.log(`Exa S2 [body of work / ${artistQueryWithContext}]:`, search2.results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate })))

  // S3: explicitly target Tier 1 art press + major general press — ensures The Art Newspaper,
  // Artforum, Frieze, Hyperallergic etc. are always in the candidate pool
  const search3 = await exa.search(`${artistQueryWithContext} artist`, {
    type: 'auto',
    numResults: 5,
    startPublishedDate: '2024-01-01',
    includeDomains: [...TIER_1_DOMAINS, 'newyorker.com', 'ft.com', 'vulture.com', 'nymag.com'],
    contents: { highlights: true },
  })
  console.log(`Exa S3 [art + major press / ${artistQueryWithContext}]:`, search3.results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate })))

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

  // S1/S2/S3's fixed wording ("artwork," "critical essay," an art-press-only domain
  // list) systematically under-recalls a crossover artist whose real coverage lives in
  // general culture/lifestyle press (music, fashion, etc.) — verified directly: Dazed
  // and Vogue pieces about a musician-artist never appeared in any of S1-S3's candidates,
  // even though a neutrally-worded query surfaces them immediately. Only runs when a real
  // disambiguator was found, so standard single-domain visual artists are unaffected.
  if (disambiguator) {
    const search5 = await exa.search(`${artistQuery} ${disambiguator} interview profile`, {
      type: 'auto',
      numResults: 5,
      contents: { highlights: true },
    })
    console.log(`Exa S5 [broader recall / ${artistQuery} ${disambiguator}]:`, search5.results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate })))
    addToPool(search5.results, 1)
  }

  const isValidAndRelevant = (r: PoolResult): r is PoolResult & { title: string } =>
    isValid(r) && isAboutArtist(r, artistQuery)

  let valid = pool.filter(isValidAndRelevant)

  if (valid.length < 2) {
    const search4 = await exa.search(`${artistQueryWithContext} art review profile`, {
      type: 'auto',
      numResults: 5,
      startPublishedDate: '2023-01-01',
      contents: { highlights: true },
    })
    console.log(`Exa S4 [fallback]:`, search4.results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate })))
    addToPool(search4.results, 2)
    valid = pool.filter(isValidAndRelevant)
  } else {
    console.log(`Exa S4 skipped (${valid.length} valid results after filtering)`)
  }

  // Name-presence alone (isAboutArtist above) can't tell "genuinely about this artist"
  // from "artist gets a passing mention in something bigger" — proven live: an Artforum
  // events index page and a Frieze multi-artist roundup both legitimately contained an
  // artist's name and passed that check, despite neither being about them specifically.
  // Run one comprehension check against the artist's own bio (preferred) or the
  // exhibition's press release to catch both that and same-named unrelated people —
  // also classifies content type (interview/profile/review/news/other) in the same call.
  let verifiedSolo = new Map<string, VerifiedCandidate>()
  if (valid.length > 0) {
    const beforeCount = valid.length
    verifiedSolo = await verifySubstantiallyAbout(`the artist "${artistQuery}"`, bios.get(artistQuery) ?? exhibition.press_release, valid)
    valid = valid.filter((r) => passesQualityGate(verifiedSolo.get(r.url)))
    console.log(`Substantially-about verification [${artistQuery}]: ${valid.length} of ${beforeCount} candidates confirmed`)
  }

  // Sort: tier → which search found it → content type → standalone-artist signal → recency
  // Tier wins first: Artforum always beats a Tier 3 blog regardless of content type.
  // contentPriority next: S2's critical-essay search is intentionally ranked above S1's
  // general search, and that's still a real signal worth keeping. Content type (from the
  // verification pass above) then breaks ties WITHIN the same priority tier — proven live:
  // two same-priority Pitchfork pieces (an interview and an album review) were tied on
  // everything above, and recency alone picked the review over the clearly-better-fit
  // interview by 4 days. This only kicks in on that kind of tie, not as an override.
  const SOLO_CONTENT_TYPE_RANK: Record<CandidateContentType, number> = {
    interview: 0, profile: 0, review: 1, news: 2, other: 2,
  }
  valid.sort((a, b) => {
    const tierDiff = getResultTier(a.url) - getResultTier(b.url)
    if (tierDiff !== 0) return tierDiff
    if (a.contentPriority !== b.contentPriority) return a.contentPriority - b.contentPriority
    const typeRankA = SOLO_CONTENT_TYPE_RANK[verifiedSolo.get(a.url)?.contentType ?? 'other']
    const typeRankB = SOLO_CONTENT_TYPE_RANK[verifiedSolo.get(b.url)?.contentType ?? 'other']
    if (typeRankA !== typeRankB) return typeRankA - typeRankB
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
  show_type: 'exhibition', artist_bio: null,
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
- artist_bio: many exhibition pages have a separate biographical section about the artist(s), often under its own heading like "About the Artist," "More About [Name]," or "Biography" — distinct from the exhibition/show description above it. Extract this verbatim if present, separately from "description." If the page has bios for multiple artists, concatenate them, each preceded by the artist's name. Null if no such section exists on the page.

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
  "show_type": "exhibition" | "installation",
  "artist_bio": "verbatim biographical text about the artist(s), separate from the exhibition description — null if no such section exists"
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
    artist_bio: raw.artist_bio ?? null,
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
    artist_bio: raw.artist_bio ?? null,
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
