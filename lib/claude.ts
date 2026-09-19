import Anthropic from '@anthropic-ai/sdk'
import Exa from 'exa-js'
import { getSupabaseAdmin } from './supabase'
import { loggedExaSearch } from './exa-log'
import { analyzeListingPage, sizingFor } from './listing-prepass'
import type { ExhibitionRaw, Preread, CoverageItem, ExhibitionLink, ExhibitionDetailExtracted, QualityFlag } from './types'

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
// Also the show review's domain filter (searchShowReview), all seven included. This
// note once said nytimes.com, theguardian.com and wsj.com make a filtered Exa search
// 403, and the filter left them out; that was never true on retest. Live 2026-09-18
// in the show-review query's exact shape, across solo, small- and large-group shows:
// 10 searches, 0 errors, 41 results from those three outlets.

// The 22 outlets the gallery solo ladder cares about. S1/S2 only SORT by it (the search
// itself is unrestricted); S3 uses it as a hard filter, all 22 included — nytimes.com,
// theguardian.com and wsj.com were once stripped on the false belief that Exa 403s
// them in a filter. Retested live 2026-09-18 in S3's and S5's exact
// query shapes: 15 searches, 0 errors, 42 results from those three outlets.
const SOLO_PRESS_DOMAINS = [
  'artforum.com', 'artnews.com', 'brooklynrail.org', 'hyperallergic.com',
  'theartnewspaper.com', 'news.artnet.com', 'bombmagazine.org', 'frieze.com',
  'artsy.net', 'elephant.art', 'culturedmag.com', 'e-flux.com', 'newyorker.com',
  'ft.com', 'nytimes.com', 'theguardian.com', 'wsj.com', 'i-d.vice.com',
  'dazeddigital.com', 'wallpaper.com', 'interviewmagazine.com', 'anothermag.com',
]

// S5's hard filter: music, fashion and general-culture press, for artists whose
// coverage lives outside the art world.
const SOLO_CROSSOVER_DOMAINS = [
  'pitchfork.com', 'stereogum.com', 'vogue.com', 'highsnobiety.com', 'hypebeast.com',
  'thefader.com', 'culturedmag.com', 'newyorker.com', 'ft.com', 'nytimes.com',
  'theguardian.com', 'wsj.com', 'i-d.vice.com', 'dazeddigital.com', 'wallpaper.com',
  'interviewmagazine.com', 'anothermag.com',
]

// Position on the 22-outlet list (0 = first), or 22 for anything off it. Museum group
// shows sort their unrestricted show search by this.
export function pressDomainRank(url: string): number {
  const host = getResultDomain(url)
  const idx = SOLO_PRESS_DOMAINS.findIndex((d) => host === d || host.endsWith(`.${d}`))
  return idx === -1 ? SOLO_PRESS_DOMAINS.length : idx
}

function isOnDomainList(url: string, domains: string[]): boolean {
  const host = getResultDomain(url)
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

// Rolling search window, computed at call time — the old ladder hardcoded
// '2024-01-01', which silently widens every year.
function rollingWindowStart(years: number, now: Date = new Date()): string {
  const d = new Date(now)
  d.setUTCFullYear(d.getUTCFullYear() - years)
  return d.toISOString().slice(0, 10)
}

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

// Pulls all known venue domains from the DB once per preread generation call. Throws
// if the read fails: an empty blocklist would let every gallery's own pages through
// as if they were press.
async function buildGalleryBlocklist(): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin().from('venues').select('exhibitions_url')
  if (error) throw new Error(`Venue blocklist read failed: ${error.message}`)
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

// ─── Mechanical self-sourced rejection ─────────────────────────────────────────
// Runs on the raw candidate pool, before verifySubstantiallyAbout ever gets called —
// a venue's own page or an artist's own site should never cost a Claude verification
// call, and should never reach the quality-gate machinery that call feeds. A rejected
// candidate is just removed from the pool here, same as isValid/isAboutArtist already
// do above — no flag is written anywhere for this.

// (a) Exact hostname match against this exhibition's own venue site. Same comparison
// audit.ts's per-exhibition cleanup pass already uses (there: extractDomain(article_url)
// === extractDomain(venue.exhibitions_url)) — getResultDomain here is the identical
// hostname-minus-www normalization, reused rather than re-derived. Deliberately an exact
// hostname match, not the registrable-domain reduction isBlockedUrl/buildGalleryBlocklist
// use elsewhere in this file: that existing mechanism already blocks every known venue's
// registrable domain (a global, coarser check, and a superset of this one for the
// registrable-domain case). This is the narrower, exhibition-specific check the audit
// route uses, added here as its own explicit step per this exhibition's own venue.
function isSelfSourcedByVenue(url: string, venueDomain: string | null): boolean {
  if (!venueDomain) return false
  return getResultDomain(url) === venueDomain
}

// (b) The artist's own name appearing as a component of the candidate domain itself —
// catches a personal site like benkvoss.com for artist "Ben K. Voss". Reuses
// significantNameParts — the exact same >2-char, no-particle-list significance filter
// isAboutArtist uses above — then requires EVERY significant part to appear in the
// domain, mirroring isAboutArtist's own "every part, not just one shared fragment"
// discipline (parts.every(...), same as line 190). That "every part" requirement is
// deliberate here for the same reason it's deliberate there: a bare single-part
// substring check would be a "loose substring" match exactly like the kind isAboutArtist
// already avoids — e.g. an artist named "Art Young" would otherwise flag artforum.com
// itself, since "art" alone is a substring of it. Requiring every significant part
// keeps a short, common name fragment from false-positiving on its own; the residual
// risk (two unrelated significant parts both happening to be substrings of the same
// unrelated domain) is the same class of known, accepted gap isAboutArtist documents
// above for mononyms — not eliminated, just made very unlikely.
function isSelfSourcedByArtistDomain(url: string, artistName: string): boolean {
  const parts = significantNameParts(artistName)
  if (parts.length === 0) return false
  const domain = registrableDomain(url).toLowerCase()
  if (!domain) return false
  return parts.every((p) => domain.includes(p.toLowerCase()))
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
// one.
//
// A candidate the check never judged is 'unverified' — not a pass. This used to
// return true when verification errored, so a Haiku outage or an unparseable reply
// published every candidate in the pool as if it had been checked. Now those
// candidates are still kept (they were never rejected), but carry quality_flag
// 'unverified', which the database blanks on insert (migration_v53) and Agent 2's
// repair pass re-checks later. `verified` is null when the whole call failed; a URL
// missing from a non-null map means the model skipped that one candidate.
type GateResult = 'pass' | 'fail' | 'unverified'

function qualityGate(verified: Map<string, VerifiedCandidate> | null, url: string): GateResult {
  const v = verified?.get(url)
  if (!v) return 'unverified'
  return v.substantiallyAbout && v.sourceType === 'editorial' ? 'pass' : 'fail'
}

// Why a candidate the check judged was rejected, in quality_flag terms. Only used to
// explain a failed repair — rejected candidates are never stored. A venue's or the
// subject's own page is self-sourced; anything else that failed (not about the
// subject, a listing/directory page, other non-press) is recorded as mismatched,
// the closest of the four values. 'no_content' has no detector yet.
function rejectionFlag(v: VerifiedCandidate): QualityFlag {
  if (v.sourceType === 'venue' || v.sourceType === 'self') return 'self_sourced'
  return 'mismatched'
}

// Drops rejected candidates and tags the ones the check never judged.
function applyQualityGate<T extends PoolResult>(candidates: T[], verified: Map<string, VerifiedCandidate> | null): T[] {
  const kept: T[] = []
  for (const c of candidates) {
    const gate = qualityGate(verified, c.url)
    if (gate === 'fail') continue
    kept.push(gate === 'unverified' ? { ...c, qualityFlag: 'unverified' as const } : c)
  }
  return kept
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
// Returns a map from URL to verification result, or null when the check itself failed
// (API error, unparseable reply). Null used to be a map marking every candidate as a
// pass — see qualityGate for why that is gone.
//
// `opts.descriptor` (the gallery solo ladder's disambiguator, e.g. "musician, composer")
// goes into the subject itself — "the artist "Klein", described as musician, composer" —
// so the check asks about THAT person, not anyone with the name. It used to reach only
// the search query, which is how a same-named stranger passed.
//
// `opts.sourceKind: 'press_release'` marks the source text as an exhibition press
// release used only to identify the subject: an artist-level check must not reject an
// article for not being about this particular show. A press release also gets a much
// longer excerpt than a bio (PRESS_RELEASE_GROUNDING_CHARS), since it is the only
// identity evidence when there is no disambiguator.
const BIO_GROUNDING_CHARS = 3000
const PRESS_RELEASE_GROUNDING_CHARS = 12000

export interface VerificationOptions {
  descriptor?: string | null
  sourceKind?: 'bio' | 'press_release' | 'show_press_release'
}

export function describeSubject(subjectLabel: string, descriptor?: string | null): string {
  return descriptor?.trim() ? `${subjectLabel}, described as ${descriptor.trim()}` : subjectLabel
}

function groundingPreamble(subject: string, sourceText: string | null, sourceKind: VerificationOptions['sourceKind']): string {
  if (!sourceText) return ''
  if (sourceKind === 'press_release') {
    return `The following exhibition press release is context for identifying ${subject} — use it only to tell them apart from other people with the same name. A result does NOT need to be about this exhibition; it only needs to be substantially about this same person:\n\n${sourceText.slice(0, PRESS_RELEASE_GROUNDING_CHARS)}\n\n`
  }
  const limit = sourceKind === 'show_press_release' ? PRESS_RELEASE_GROUNDING_CHARS : BIO_GROUNDING_CHARS
  return `The following text describes ${subject}:\n\n${sourceText.slice(0, limit)}\n\n`
}

export function buildVerificationPrompt(
  subjectLabel: string,
  sourceText: string | null,
  candidates: (PoolResult & { title: string })[],
  opts: VerificationOptions = {}
): string {
  const subject = describeSubject(subjectLabel, opts.descriptor)
  return `${groundingPreamble(subject, sourceText, opts.sourceKind)}Below are web search results that may or may not be genuinely, substantially about ${subject}.

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
[{"url": "...", "substantially_about": true, "content_type": "interview", "source_type": "editorial"}]`
}

async function verifySubstantiallyAbout(
  subjectLabel: string,
  sourceText: string | null,
  candidates: (PoolResult & { title: string })[],
  opts: VerificationOptions = {}
): Promise<Map<string, VerifiedCandidate> | null> {
  if (candidates.length === 0) return new Map()

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: buildVerificationPrompt(subjectLabel, sourceText, candidates, opts),
    }],
  }).catch(() => null)

  if (!response) {
    console.error(`Quality check failed for ${subjectLabel}: API error — ${candidates.length} candidate(s) left unverified`)
    return null
  }
  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  const parsed = extractJsonArray<{ url: string; substantially_about: boolean; content_type?: string; source_type?: string }>(text)
  if (!parsed) {
    console.error(`Quality check failed for ${subjectLabel}: unparseable reply — ${candidates.length} candidate(s) left unverified`)
    return null
  }

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

export type PrereadRow = Omit<Preread, 'id' | 'exhibition_id' | 'created_at'>
export interface GeneratePrereadsResult {
  prereads: PrereadRow[]
  hasShowCoverage: boolean
  // Set when the show can't be searched at all. Nothing ran; the caller records the
  // status on the exhibition and stops — it must not treat this as an empty result.
  blocked: 'pending_artists' | null
  // Gallery shows (solo, small and large group): whether the show review ran this
  // time and what it found.
  showReview?: ShowReviewAttempt
  // Small and large group: artists whose search never got an answer (not the same as
  // finding nothing) and who still have no piece. Agent 2 stores everything that was
  // found, records these names on the show (preread_retry_artists, migration_v58),
  // marks it 'error', and its next run searches only them (see ArtistRetry).
  retryArtists?: string[]
  // The failed-search messages behind retryArtists, for the run's error log.
  searchErrors?: string[]
  // Solo: the URLs among `prereads` that are the show review (S4), so a museum solo
  // show can label them show_coverage for its public page's ordering.
  showReviewUrls?: string[]
}

/**
 * A retry run (migration_v58): search only these artists — the ones whose search
 * failed last time — and, for large group, fill at most `artistSlots` artist pieces
 * (5 minus the artist pieces already stored), so the show still can't pass 1 + 5.
 */
export interface ArtistRetry {
  artists: string[]
  artistSlots: number
}

// contentPriority: 0 = show review (S2), 1 = artist profile/interview (S1), 2 = general press (S3/S4)
interface PoolResult {
  title: string | null
  url: string
  publishedDate?: string
  // Exa's own response shape (confirmed live) — present when the source page
  // exposes byline metadata, absent otherwise. Was never declared here even
  // though museum-coverage.ts's parallel MuseumSearchResult type already
  // captures the identical field from the identical API; every construction
  // site below spreads the raw Exa object (`{ ...r, ... }`), so declaring it
  // here is sufficient to carry it through — no reshaping needed elsewhere.
  author?: string
  highlights: string[]
  image?: string
  contentPriority: 0 | 1 | 2
  // Set only when the quality check never judged this candidate — see qualityGate.
  qualityFlag?: 'unverified'
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

// `artistName` is optional and absent on show-review results (no single artist is
// bound to a whole-show search) — mirrors museum-coverage.ts's toCoverageItem, which
// takes the same null-for-show/set-for-per-artist artistName parameter.
function toPrereadRow(r: PoolResult & { title: string; artistName?: string | null }): PrereadRow {
  return {
    article_title: r.title,
    publication: publicationFromUrl(r.url),
    article_url: r.url,
    summary: r.highlights?.[0] ?? null,
    thumbnail_url: r.image ?? null,
    author: r.author ?? null,
    published_date: r.publishedDate ?? null,
    artist_name: r.artistName ?? null,
    quality_flag: r.qualityFlag ?? null,
  }
}

type GalleryShowType = 'solo' | 'small_group' | 'large_group'

// null = no artists: there is no one to search for. This used to fall through to
// 'solo', which ran the solo ladder on an empty name.
function classifyGalleryShow(artistCount: number): GalleryShowType | null {
  if (artistCount === 0) return null
  if (artistCount === 1) return 'solo'
  if (artistCount <= 5) return 'small_group'
  return 'large_group'
}

// ─── Show-review pre-filter (gallery solo S4) ─────────────────────────────────
// Lowercase, accents stripped, punctuation collapsed to single spaces — so
// "Vásquez de la Horra: Reading the Waves" and "vasquez de la horra reading the waves"
// compare equal.
export function normalizeForMatch(s: string): string {
  return ` ${s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
}

function containsPhrase(normalizedText: string, phrase: string): boolean {
  const p = normalizeForMatch(phrase)
  return p.trim().length > 0 && normalizedText.includes(p)
}

// The ways a review can name the show: the full title, or — for a title that bundles
// the artist's name ("Sandra Vásquez de la Horra: Reading the Waves") — the part that
// isn't the name. A bare artist-name title ("Yoshitomo Nara") has no such part, and
// matching the name alone would let any article about the artist through, so it
// only matches in full.
function showTitleVariants(showTitle: string, artists: string[]): string[] {
  const segments = showTitle.split(/\s*[:|–—]\s*/).map((p) => p.trim())
  if (segments.length < 2) return [showTitle]
  const names = new Set(artists.map((a) => normalizeForMatch(a)))
  return [showTitle, ...segments.filter((p) => p.length >= 4 && !names.has(normalizeForMatch(p)))]
}

// Mechanical check before any AI call: the candidate's title/highlights must name the
// exhibition AND at least one of its real artists. No venue-name check — a review
// often names the gallery only in a byline or not at all.
export function mentionsShowAndArtist(r: { title: string | null; highlights?: string[] }, showTitle: string, artists: string[]): boolean {
  const text = normalizeForMatch([r.title ?? '', ...(r.highlights ?? [])].join(' '))
  const hasTitle = showTitleVariants(showTitle, artists).some((t) => containsPhrase(text, t))
  const hasArtist = artists.some((a) => containsPhrase(text, a))
  return hasTitle && hasArtist
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
  pressRelease: string | null,
  venueDomain: string | null,
  exhibitionId: string | null,
  // Every gallery tier (solo's S4, small and large group): the mechanical title +
  // artist pre-filter, run before any AI call.
  requireTitleAndArtist?: { artists: string[] }
): Promise<{ rows: (PoolResult & { title: string })[]; searchFailed: boolean }> {
  // Last year and this year, computed per run (was a hardcoded "2025 OR 2026").
  const year = new Date().getUTCFullYear()
  const query = `${showTitle} ${venueName} review exhibition ${year - 1} OR ${year}`

  // Self-sourced check (a) folded into the same validity predicate as isValid — a
  // candidate on the exhibition's own venue domain is rejected here, before either
  // the retry-count check below or verifySubstantiallyAbout ever sees it.
  const isValidCandidate = (r: PoolResult): r is PoolResult & { title: string } =>
    isValid(r) && !isSelfSourcedByVenue(r.url, venueDomain)
      && !(requireTitleAndArtist?.artists ?? []).some((a) => isSelfSourcedByArtistDomain(r.url, a))
      && (!requireTitleAndArtist || mentionsShowAndArtist(r, showTitle, requireTitleAndArtist.artists))

  const filtered = await loggedExaSearch(exa, query, {
    type: 'auto',
    numResults: 5,
    includeDomains: TIER_2_DOMAINS,
    contents: { highlights: true },
  }, { exhibitionId, functionName: 'searchShowReview' })

  // True if either Exa call never got an answer (not the same as an empty answer).
  let searchFailed = !!filtered.error
  let candidates = sortByTierAndRecency((filtered.results as unknown as PoolResult[]).filter(isValidCandidate))

  if (candidates.length < minDomainFilteredResults) {
    console.log(`Exa show-review [${showTitle}]: only ${candidates.length} domain-filtered result(s) (need ${minDomainFilteredResults}) — retrying without domain filter`)
    const unfiltered = await loggedExaSearch(exa, query, {
      type: 'auto',
      numResults: 5,
      contents: { highlights: true },
    }, { exhibitionId, functionName: 'searchShowReview' })
    searchFailed ||= !!unfiltered.error

    const seen = new Set(candidates.map((r) => r.url))
    const extra = (unfiltered.results as unknown as PoolResult[]).filter(isValidCandidate).filter((r) => !seen.has(r.url))
    candidates = sortByTierAndRecency([...candidates, ...extra])
  } else {
    console.log(`Exa show-review [${showTitle}]: ${candidates.length} domain-filtered result(s) — no retry needed`)
  }

  if (candidates.length > 0) {
    const verified = await verifySubstantiallyAbout(
      `the exhibition "${showTitle}" at ${venueName}`,
      pressRelease,
      candidates,
      requireTitleAndArtist ? { sourceKind: 'show_press_release' } : {}
    )
    candidates = applyQualityGate(candidates, verified)
  }

  return { rows: candidates.slice(0, wantCount).map((r) => ({ ...r, contentPriority: 0 as const })), searchFailed }
}

// Single artist profile/interview search, no domain filter unless the caller passes
// one — shared by both group tiers. `disambiguator`, when present, is a short phrase
// (from the artist's bio, or the exhibition's press release as fallback) appended to
// the query to widen recall toward the right person — helpful even if imprecise, since
// the verification pass below (not this query) is what actually guarantees precision.
// `sourceText` is the artist's own bio when one exists, else the shared press release —
// passed through to that verification pass as the grounding text to reason against.
async function searchArtistProfile(
  exa: Exa,
  artistName: string,
  isValid: (r: PoolResult) => r is PoolResult & { title: string },
  disambiguator?: string,
  sourceText?: string | null,
  venueDomain?: string | null,
  exhibitionId?: string | null,
  // Small and large group pass verifyArtistCandidates here so the check itself says
  // "described as {disambiguator}". Without it, the bare-name check is grounded in
  // sourceText.
  verify?: (candidates: (PoolResult & { title: string })[]) => Promise<Map<string, VerifiedCandidate> | null>,
  // Large group's Pass 1: a hard domain filter, and a hook for a search that never got
  // an answer (so it isn't mistaken for a clean empty result).
  searchOpts: { includeDomains?: string[]; onSearchFailed?: (error: string) => void } = {}
): Promise<(PoolResult & { title: string }) | null> {
  const query = disambiguator
    ? `${artistName} ${disambiguator} artist interview profile`
    : `${artistName} artist interview profile`

  const results = await loggedExaSearch(exa, query, {
    type: 'auto',
    numResults: 5,
    ...(searchOpts.includeDomains ? { includeDomains: searchOpts.includeDomains } : {}),
    contents: { highlights: true },
  }, { exhibitionId: exhibitionId ?? null, functionName: 'searchArtistProfile' })
  if (results.error) searchOpts.onSearchFailed?.(results.error)

  // Self-sourced checks (a) and (b) — same "reject before any Claude call" placement
  // as isValid/isAboutArtist right next to them, not a separate pass afterward.
  const named = (results.results as unknown as PoolResult[])
    .filter(isValid)
    .filter((r) => isAboutArtist(r, artistName))
  let candidates = named
    .filter((r) => !isSelfSourcedByVenue(r.url, venueDomain ?? null))
    .filter((r) => !isSelfSourcedByArtistDomain(r.url, artistName))
  if (candidates.length < named.length) {
    const dropped = named.filter((r) => !candidates.includes(r)).map((r) => r.url)
    console.log(`Self-sourced rejected [${artistName}]: ${dropped.join(', ')}`)
  }

  let verified: Map<string, VerifiedCandidate> | null = new Map()
  if (candidates.length > 0) {
    verified = verify
      ? await verify(candidates)
      : await verifySubstantiallyAbout(`the artist "${artistName}"`, sourceText ?? null, candidates)
    candidates = applyQualityGate(candidates, verified)
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
    const rankA = CONTENT_TYPE_RANK[verified?.get(a.url)?.contentType ?? 'other']
    const rankB = CONTENT_TYPE_RANK[verified?.get(b.url)?.contentType ?? 'other']
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
// Throws if the read fails, rather than carrying on as if no artist had a bio.
async function fetchArtistBios(artistNames: string[]): Promise<Map<string, string>> {
  if (artistNames.length === 0) return new Map()
  const { data, error } = await getSupabaseAdmin().from('artists').select('name, bio').in('name', artistNames)
  if (error) throw new Error(`Artist bio read failed: ${error.message}`)
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
//
// null = the call failed (retried once by the caller); '' = nothing distinctive stated.
async function extractDisambiguatorFromBio(artistName: string, bio: string): Promise<string | null> {
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
  if (!response) return null
  return response.content.find((b) => b.type === 'text')?.text?.trim() ?? ''
}

// A failed extraction doesn't stop the search — it only loses the name-clash
// protection — so it used to fail silently. Now: one retry, and a loud log if both fail.
async function withOneRetry<T>(label: string, attempt: () => Promise<T | null>): Promise<T | null> {
  const first = await attempt()
  if (first !== null) return first
  console.warn(`Disambiguator extraction failed [${label}] — retrying once`)
  const second = await attempt()
  if (second !== null) {
    console.log(`Disambiguator extraction recovered on retry [${label}]`)
    return second
  }
  console.error(`Disambiguator extraction FAILED twice [${label}] — searching WITHOUT name-clash protection`)
  return null
}

// Extracts a short disambiguating phrase per artist — from their own bio when one
// exists (safer, single-subject), falling back to the exhibition's shared press
// release for artists with no bio on file. Used to steer searches away from unrelated
// people who happen to share the artist's name. Falls back to no context for any
// artist with nothing usable found; callers must treat a missing entry as "search
// unmodified," never as an error.
export async function extractArtistSearchContext(
  pressRelease: string | null,
  artistNames: string[],
  bios: Map<string, string>
): Promise<Map<string, string>> {
  const empty = new Map<string, string>()
  if (artistNames.length === 0) return empty

  const context = new Map<string, string>()

  const bioResults = await Promise.all(
    [...bios.entries()].map(async ([name, bio]) => [name, await withOneRetry(`bio / ${name}`, () => extractDisambiguatorFromBio(name, bio))] as const)
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
  // An API error or an unparseable reply counts as a failure (retried once).
  const parsed = await withOneRetry(`press release / ${remaining.length} artist(s)`, async () => {
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
    if (!response) return null
    return extractJsonObject<Record<string, string>>(response.content.find((b) => b.type === 'text')?.text ?? '')
  })
  if (!parsed) return context

  for (const name of remaining) {
    const phrase = parsed[name]?.trim()
    if (phrase) context.set(name, phrase)
  }
  return context
}

// The one way an artist-level candidate is checked — the gallery solo ladder, and the
// repair / Replace paths for solo and group rows alike, so a repaired row clears
// exactly the bar a freshly generated one did. With a disambiguator, it goes into the
// subject ("the artist "Klein", described as composer, …"), backed by the artist's own
// bio when there is one. Without one, the full press release is the identity evidence.
async function verifyArtistCandidates<T extends PoolResult & { title: string }>(
  artistName: string,
  disambiguator: string | null,
  bio: string | null,
  pressRelease: string | null,
  candidates: T[]
): Promise<Map<string, VerifiedCandidate> | null> {
  const label = `the artist "${artistName}"`
  if (disambiguator) return verifySubstantiallyAbout(label, bio, candidates, { descriptor: disambiguator, sourceKind: 'bio' })
  return pressRelease
    ? verifySubstantiallyAbout(label, pressRelease, candidates, { sourceKind: 'press_release' })
    : verifySubstantiallyAbout(label, bio, candidates, { sourceKind: 'bio' })
}

// Large group's search order: shuffled, then every artist with a real disambiguator
// ahead of every artist without one (the shuffle holds within each half). Random so
// the same alphabetical front of a big roster doesn't win every show's slots; a
// disambiguator first because it's what makes a same-named stranger checkable.
export function orderLargeGroupArtists(
  artistNames: string[],
  context: Map<string, string>,
  random: () => number = Math.random
): string[] {
  const shuffled = [...artistNames]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const hasContext = (a: string) => !!context.get(a)?.trim()
  return [...shuffled.filter(hasContext), ...shuffled.filter((a) => !hasContext(a))]
}

// ─── Small Group (2-5 artists) ─────────────────────────────────────────────
// One result per artist (every artist is searched), plus the show review once the
// show has been open 14 days — the same gate, pre-filter and check as gallery solo's
// S4, run later by the daily show-review cron when not yet due. No overall cap: 5 is
// already the most artists this tier can have, so the review is a 6th slot rather
// than displacing an artist's piece.
async function generateSmallGroupPrereads(
  exa: Exa,
  exhibition: ExhibitionRaw & { venue_name: string; exhibition_id?: string | null; show_review_due?: boolean; retry?: ArtistRetry },
  isValid: (r: PoolResult) => r is PoolResult & { title: string },
  context: Map<string, string>,
  bios: Map<string, string>,
  venueDomain: string | null
): Promise<GeneratePrereadsResult> {
  const exhibitionId = exhibition.exhibition_id ?? null
  const showTitle = exhibition.show_title

  let showReview: (PoolResult & { title: string })[] = []
  const showReviewAttempt: ShowReviewAttempt = { ran: false, result: null }
  if (exhibition.show_review_due) {
    showReviewAttempt.ran = true
    try {
      const s4 = await searchShowReview(exa, showTitle, exhibition.venue_name, isValid, 1, 1, exhibition.press_release, venueDomain, exhibitionId, { artists: exhibition.artists })
      showReview = s4.rows
      showReviewAttempt.result = showReviewResult(s4)
    } catch (err) {
      console.error(`Show review failed [Small Group / ${showTitle}]:`, err)
      showReviewAttempt.result = 'error'
    }
  } else {
    console.log(`Exa show-review skipped [Small Group / ${showTitle}]: not due yet (14 days after opening)`)
  }

  // Zipped with the artist name here, before Promise.all resolves — this is the only
  // point where "which artist produced this result" and the result itself are both in
  // scope together; once results flatten into perArtist/combined below, only the
  // artistName carried on each object survives.
  // A retry run searches only the artists whose search failed last time.
  const toSearch = exhibition.retry?.artists ?? exhibition.artists
  if (exhibition.retry) console.log(`Exa per-artist [Small Group / ${showTitle}]: retry run — searching only ${toSearch.join(', ')}`)
  const failedSearches = new Map<string, string>()
  const perArtistResults = await Promise.all(
    toSearch.map(async (artist) => {
      const disambiguator = context.get(artist)?.trim() || null
      const result = await searchArtistProfile(exa, artist, isValid, disambiguator ?? undefined, bios.get(artist) ?? exhibition.press_release, venueDomain, exhibitionId,
        (candidates) => verifyArtistCandidates(artist, disambiguator, bios.get(artist) ?? null, exhibition.press_release, candidates),
        {
          onSearchFailed: (error) => {
            failedSearches.set(artist, error)
            console.error(`Exa per-artist search FAILED [Small Group / ${artist}]: ${error}`)
          },
        })
      return result ? { ...result, artistName: artist } : null
    })
  )

  const seenUrls = new Set(showReview.map((r) => r.url))
  const perArtist: (PoolResult & { title: string; artistName: string })[] = []
  for (const result of perArtistResults) {
    if (!result || seenUrls.has(result.url)) continue
    seenUrls.add(result.url)
    perArtist.push(result)
  }

  const combined = [...showReview, ...perArtist]
  console.log(`Exa selected [Small Group / ${showTitle}]:`, combined.map((r) => ({ title: r.title, url: r.url })))
  // A failed search returns no results, so every artist here has no piece.
  const retryArtists = [...failedSearches.keys()]
  return {
    prereads: combined.map(toPrereadRow), hasShowCoverage: showReview.length > 0, blocked: null, showReview: showReviewAttempt,
    ...(retryArtists.length > 0 ? { retryArtists, searchErrors: retryArtists.map((a) => `${a}: ${failedSearches.get(a)}`) } : {}),
  }
}

// ─── Large Group (6+ artists) ───────────────────────────────────────────────
// Up to 1 show review + 5 artist pieces (6 total). The show review is on the same
// 14-day gate, pre-filter and check as gallery solo's S4.
//
// Artists are searched in orderLargeGroupArtists' order, in two passes:
//   Pass 1  the 22 outlets as a HARD filter, until 5 artists have a verified piece or
//           the whole roster has been tried
//   Pass 2  only if Pass 1 fell short: the Pass-1 misses (empty, unverified, failed
//           search, or a URL another artist already took), unfiltered, until 5
// A verified Pass-1 artist is never searched again. Each round launches only as many
// searches as there are slots left, so a big roster isn't searched past the cap.
// Fewer than 5 is a normal outcome, not a failure. A piece the check never judged
// ('unverified') only fills a slot no verified piece could, and is blanked on insert.
//
// All 22 outlets are passed to Exa. The old note (above TIER_2_DOMAINS's filtered subset) that
// nytimes.com, theguardian.com and wsj.com make the whole filtered search 403 did not
// reproduce on 2026-09-18: each of the three alone, and all 22 together, returned
// results. If Exa starts refusing them again, loggedExaSearch reports the error.
//
// An artist whose LAST search never got an answer, and who ended with no piece while
// slots were still open, is returned in retryArtists. Agent 2 stores what was found,
// marks the show 'error', and the retry searches only those artists, for only the
// slots still open. A failure that didn't cost anything (Pass 2 recovered the artist,
// or all 5 slots filled anyway) is logged but isn't an error.
const LARGE_GROUP_ARTIST_CAP = 5
const LARGE_GROUP_PASS1_DOMAINS = SOLO_PRESS_DOMAINS

async function generateLargeGroupPrereads(
  exa: Exa,
  exhibition: ExhibitionRaw & { venue_name: string; exhibition_id?: string | null; show_review_due?: boolean; retry?: ArtistRetry },
  isValid: (r: PoolResult) => r is PoolResult & { title: string },
  context: Map<string, string>,
  bios: Map<string, string>,
  venueDomain: string | null
): Promise<GeneratePrereadsResult> {
  const exhibitionId = exhibition.exhibition_id ?? null
  const showTitle = exhibition.show_title

  let showReview: (PoolResult & { title: string })[] = []
  const showReviewAttempt: ShowReviewAttempt = { ran: false, result: null }
  if (exhibition.show_review_due) {
    showReviewAttempt.ran = true
    try {
      const s4 = await searchShowReview(exa, showTitle, exhibition.venue_name, isValid, 1, 1, exhibition.press_release, venueDomain, exhibitionId, { artists: exhibition.artists })
      showReview = s4.rows
      showReviewAttempt.result = showReviewResult(s4)
    } catch (err) {
      console.error(`Show review failed [Large Group / ${showTitle}]:`, err)
      showReviewAttempt.result = 'error'
    }
  } else {
    console.log(`Exa show-review skipped [Large Group / ${showTitle}]: not due yet (14 days after opening)`)
  }

  type Hit = PoolResult & { title: string; artistName: string }
  const seenUrls = new Set(showReview.map((r) => r.url))
  const verifiedHits: Hit[] = []
  const unverifiedHits = new Map<string, Hit>()
  const pass1Misses: string[] = []
  const failedSearches: string[] = []
  const lastSearchFailed = new Map<string, boolean>()
  // A retry run fills only the slots still open, from only the artists that failed.
  const artistCap = Math.min(LARGE_GROUP_ARTIST_CAP, exhibition.retry?.artistSlots ?? LARGE_GROUP_ARTIST_CAP)

  const searchOne = async (artist: string, pass: 1 | 2): Promise<Hit | null> => {
    const disambiguator = context.get(artist)?.trim() || null
    let failed = false
    const result = await searchArtistProfile(exa, artist, isValid, disambiguator ?? undefined, bios.get(artist) ?? exhibition.press_release, venueDomain, exhibitionId,
      (candidates) => verifyArtistCandidates(artist, disambiguator, bios.get(artist) ?? null, exhibition.press_release, candidates),
      {
        includeDomains: pass === 1 ? LARGE_GROUP_PASS1_DOMAINS : undefined,
        onSearchFailed: (error) => {
          failed = true
          failedSearches.push(`Pass ${pass} / ${artist}: ${error}`)
          console.error(`Exa per-artist search FAILED [Large Group Pass ${pass} / ${artist}]${pass === 1 ? ` (${LARGE_GROUP_PASS1_DOMAINS.length}-outlet filter)` : ''}: ${error}`)
        },
      })
    lastSearchFailed.set(artist, failed)
    // Belt and braces on the hard filter: a Pass-1 piece off the list doesn't count.
    if (result && pass === 1 && !isOnDomainList(result.url, LARGE_GROUP_PASS1_DOMAINS)) return null
    return result ? { ...result, artistName: artist } : null
  }

  const runPass = async (pass: 1 | 2, queue: string[]) => {
    let next = 0
    while (next < queue.length && verifiedHits.length < artistCap) {
      const batch = queue.slice(next, next + artistCap - verifiedHits.length)
      next += batch.length
      const results = await Promise.all(batch.map((artist) => searchOne(artist, pass)))
      batch.forEach((artist, i) => {
        const hit = results[i]
        const fresh = hit && !seenUrls.has(hit.url)
        if (fresh && !hit.qualityFlag) {
          seenUrls.add(hit.url)
          verifiedHits.push(hit)
          console.log(`Exa per-artist [Large Group Pass ${pass} / ${artist}]: verified — ${hit.title} (${hit.url})`)
          return
        }
        if (fresh) unverifiedHits.set(artist, hit)
        if (pass === 1) pass1Misses.push(artist)
        console.log(`Exa per-artist [Large Group Pass ${pass} / ${artist}]: ${!hit ? 'nothing passed' : !fresh ? `duplicate URL (${hit.url})` : `unverified only (${hit.url})`}`)
      })
    }
    if (next < queue.length) {
      console.log(`Exa per-artist [Large Group Pass ${pass}]: ${artistCap} verified — not searched: ${queue.slice(next).join(', ')}`)
    }
  }

  const ordered = orderLargeGroupArtists(exhibition.retry?.artists ?? exhibition.artists, context)
  if (exhibition.retry) console.log(`Exa per-artist [Large Group / ${showTitle}]: retry run — ${artistCap} slot(s) open, searching only ${ordered.join(', ')}`)
  console.log(`Exa per-artist [Large Group / ${showTitle}] order:`, ordered.map((a) => `${a}${context.get(a)?.trim() ? ' *' : ''}`).join(', '))
  await runPass(1, ordered)
  if (verifiedHits.length < artistCap && pass1Misses.length > 0) {
    console.log(`Exa per-artist [Large Group]: Pass 1 found ${verifiedHits.length} — Pass 2 re-searches ${pass1Misses.length} miss(es) unfiltered`)
    await runPass(2, pass1Misses)
  }

  // Unverified pieces fill only slots no verified piece could, in search order, one per
  // artist who has no verified piece.
  const artistRows: Hit[] = [...verifiedHits]
  for (const artist of ordered) {
    if (artistRows.length >= artistCap) break
    const hit = unverifiedHits.get(artist)
    if (!hit || seenUrls.has(hit.url) || artistRows.some((r) => r.artistName === artist)) continue
    seenUrls.add(hit.url)
    artistRows.push(hit)
  }
  if (failedSearches.length > 0) {
    console.error(`Exa per-artist [Large Group / ${showTitle}]: ${failedSearches.length} search(es) never got an answer — ${failedSearches.join(' | ')}`)
  }
  // Only a failure that may have cost a piece: the artist's last search failed, they
  // have no piece, and a slot was left open for them.
  const retryArtists = artistRows.length < artistCap
    ? ordered.filter((a) => lastSearchFailed.get(a) && !artistRows.some((r) => r.artistName === a))
    : []
  if (failedSearches.length > 0 && retryArtists.length === 0) {
    console.log(`Exa per-artist [Large Group / ${showTitle}]: failed search(es) cost nothing (recovered, or every slot filled) — no retry needed`)
  }

  const combined = [...showReview, ...artistRows]
  console.log(`Exa selected [Large Group / ${showTitle}]:`, combined.map((r) => ({ title: r.title, url: r.url, artist: (r as Partial<Hit>).artistName ?? null })))
  return {
    prereads: combined.map(toPrereadRow), hasShowCoverage: showReview.length > 0, blocked: null, showReview: showReviewAttempt,
    ...(retryArtists.length > 0 ? { retryArtists, searchErrors: failedSearches.filter((m) => retryArtists.some((a) => m.includes(` / ${a}: `))) } : {}),
  }
}

export async function generatePrereads(
  exhibition: ExhibitionRaw & {
    venue_name: string
    venue_url?: string | null
    exhibition_id?: string | null
    // Gallery shows (every tier): whether the show review (solo's S4) may run now —
    // see isShowReviewDue. Absent means not due; the daily show-review cron runs it later.
    show_review_due?: boolean
    // Small and large group: a retry run for artists whose search failed (see ArtistRetry).
    retry?: ArtistRetry
    // Disambiguators already extracted by the caller (museum solo does it for its
    // era check) — the same extraction, so it isn't paid for or re-rolled twice.
    search_context?: Map<string, string>
  }
): Promise<GeneratePrereadsResult> {
  const exa = new Exa(process.env.EXA_API_KEY!)
  const showType = classifyGalleryShow(exhibition.artists.length)
  // Checked before anything that costs money — the blocklist, bio and disambiguator
  // calls below all run for every show that gets past here.
  if (showType === null) return { prereads: [], hasShowCoverage: false, blocked: 'pending_artists' }

  // This exhibition's own venue domain — computed once, threaded down to
  // searchShowReview/searchArtistProfile for the mechanical self-sourced check (a).
  // Optional/nullable because not every caller has plumbed venue_url through yet;
  // absent just means that specific check is skipped (isBlockedUrl's global,
  // registrable-domain blocklist below still applies regardless).
  const venueDomain = exhibition.venue_url ? getResultDomain(exhibition.venue_url) || null : null

  // Build blocklist once — shared across all search paths
  const galleryDomains = await buildGalleryBlocklist()
  const isValid = (r: PoolResult): r is PoolResult & { title: string } =>
    !!r.title?.trim() && !isBlockedUrl(r.url, galleryDomains)

  // Bios (populated by Agent 1 from a page's own "About the Artist" section, solo
  // shows only) are a safer disambiguation source than the press release — single-
  // subject, no risk of misattributing a detail about someone else mentioned in the
  // same text. Fetched once and reused for both query-context extraction below and the
  // mononym verification pass further down.
  // A retry run (small / large group) only searches the artists that failed last time.
  const searchArtists = exhibition.retry?.artists ?? exhibition.artists
  const bios = await fetchArtistBios(searchArtists)

  // One cheap call per exhibition, extracting a short disambiguating phrase per artist
  // (e.g. "musician and filmmaker") from their own bio when available, else the show's
  // shared press release — steers searches away from unrelated same-named people.
  // No-ops if nothing usable is found; every query below degrades gracefully.
  const searchContext = exhibition.search_context
    ?? await extractArtistSearchContext(exhibition.press_release, searchArtists, bios)

  if (showType === 'small_group') {
    return generateSmallGroupPrereads(exa, exhibition, isValid, searchContext, bios, venueDomain)
  }

  if (showType === 'large_group') {
    return generateLargeGroupPrereads(exa, exhibition, isValid, searchContext, bios, venueDomain)
  }

  // ─── Solo path (1 artist) ─────────────────────────────────────────────────
  return generateSoloPrereads(exa, exhibition, isValid, searchContext, bios, venueDomain)
}

// ─── Gallery solo ladder (S1-S5) ─────────────────────────────────────────────
//
// Also the contemporary museum solo ladder: generateMuseumCoverage calls
// generatePrereads for it, unchanged.
//
//   S1  broad recent coverage       rolling 2 years, unrestricted, 22 domains sort first
//   S2  body of work / interview    same window and sort; checked against the artist's
//                                   practice, never the current show
//   S3  prominent outlet            22 domains as a HARD filter; only with a real
//                                   disambiguator
//   S4  show review                 the shared searchShowReview, gated 14 days after
//                                   opening (showReviewDue); otherwise the daily
//                                   show-review cron runs it later
//   S5  non-art crossover           only if S1 and S2 both came back empty after the
//                                   check AND the disambiguator names a non-fine-art
//                                   role; hard-filtered to music/fashion/culture press
//
// Every stage: self-sourced checks (venue domain, artist-name domain) before any AI
// call; then verifySubstantiallyAbout with the disambiguator in the subject when there
// is one, else the full press release as grounding. A candidate the check never judged
// is kept with quality_flag 'unverified' (the database blanks it).

const SOLO_WINDOW_YEARS = 2
export const SHOW_REVIEW_DELAY_DAYS = 14

/** show_review_pending_until for a show: its opening plus 14 days (today + 14 if no opening date). */
export function showReviewPendingUntil(startDate: string | null, now: Date = new Date()): string {
  const base = startDate ? new Date(`${startDate.slice(0, 10)}T00:00:00Z`) : new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z')
  base.setUTCDate(base.getUTCDate() + SHOW_REVIEW_DELAY_DAYS)
  return base.toISOString().slice(0, 10)
}

/**
 * What one S4 run produced. 'empty' means the search answered and nothing passed;
 * 'error' means a search call never got an answer (or the run threw).
 */
export type ShowReviewResult = 'found' | 'empty' | 'error'

/**
 * exhibitions.show_review_status (migration_v55). Errors climb error1 → error2 →
 * error3, the same ladder as a venue's scrape_status: error1/error2 are retried on
 * the next run, error3 is the hard wall. 'found' and 'empty' are final on the first
 * clean result — an empty search is never retried.
 */
export type ShowReviewStatus = 'found' | 'empty' | 'error1' | 'error2' | 'error3'
export const MAX_SHOW_REVIEW_ERRORS = 3

/** The status to store after a run, given the status before it. */
export function nextShowReviewStatus(previous: ShowReviewStatus | null, result: ShowReviewResult): ShowReviewStatus {
  if (result !== 'error') return result
  const failures = previous === 'error1' ? 1 : previous === 'error2' ? 2 : previous === 'error3' ? 3 : 0
  return `error${Math.min(failures + 1, MAX_SHOW_REVIEW_ERRORS)}` as ShowReviewStatus
}

/**
 * Whether a show's S4 search may run now: its 14 days are up, and it has never been
 * attempted — or it has errored fewer than 3 times.
 */
export function isShowReviewDue(
  pendingUntil: string | null,
  attemptedAt: string | null,
  status: ShowReviewStatus | null,
  now: Date = new Date()
): boolean {
  if (!pendingUntil) return false
  if (pendingUntil.slice(0, 10) > now.toISOString().slice(0, 10)) return false
  return attemptedAt === null || status === 'error1' || status === 'error2'
}

// A disambiguator that places the artist outside fine art — the only case S5's
// music/fashion/culture outlets are worth searching.
const NON_FINE_ART_ROLE_RE = /\b(musician|singer|songwriter|rapper|composer|dj|producer|band|vocalist|guitarist|drummer|pianist|bassist|record label|album|fashion|designer|stylist|model|streetwear|actor|actress|filmmaker|film director|director|screenwriter|comedian|dancer|choreographer|writer|novelist|poet|author|chef|architect|skateboarder|tattoo|creative director)s?\b/i

export function isNonFineArtDisambiguator(disambiguator: string | null | undefined): boolean {
  return !!disambiguator && NON_FINE_ART_ROLE_RE.test(disambiguator)
}

/** What the solo path did about S4 this run — the caller writes it to the show_review_* columns. */
export interface ShowReviewAttempt {
  ran: boolean
  result: ShowReviewResult | null
}

type SoloStage = 'S1' | 'S2' | 'S3' | 'S5'

// contentPriority for the solo pool: 0 = show review (S4), 1 = body of work (S2),
// 2 = everything else. Kept as a sort signal below the domain list.
const SOLO_STAGE_PRIORITY: Record<SoloStage, 1 | 2> = { S1: 2, S2: 1, S3: 2, S5: 2 }

async function generateSoloPrereads(
  exa: Exa,
  exhibition: ExhibitionRaw & { venue_name: string; exhibition_id?: string | null; show_review_due?: boolean },
  isValid: (r: PoolResult) => r is PoolResult & { title: string },
  context: Map<string, string>,
  bios: Map<string, string>,
  venueDomain: string | null
): Promise<GeneratePrereadsResult> {
  const exhibitionId = exhibition.exhibition_id ?? null
  const showTitle = exhibition.show_title
  const artist = exhibition.artists[0]
  const disambiguator = context.get(artist)?.trim() || null
  const withContext = disambiguator ? `${artist} ${disambiguator}` : artist
  const windowStart = rollingWindowStart(SOLO_WINDOW_YEARS)

  // Grounding for every artist-level check. With a disambiguator, it goes into the
  // subject ("…described as …"), backed by the artist's own bio when there is one.
  // Without one, the full press release is the only identity evidence available.
  const verifyArtist = (candidates: (PoolResult & { title: string })[]) =>
    verifyArtistCandidates(artist, disambiguator, bios.get(artist) ?? null, exhibition.press_release, candidates)

  // Name present, not blocked, not the venue's or the artist's own site — all before
  // any AI call.
  const passesMechanical = (r: PoolResult): r is PoolResult & { title: string } =>
    isValid(r)
    && isAboutArtist(r, artist)
    && !isSelfSourcedByVenue(r.url, venueDomain)
    && !isSelfSourcedByArtistDomain(r.url, artist)

  const search = async (stage: SoloStage, query: string, opts: { startPublishedDate?: string; includeDomains?: string[] }) => {
    const res = await loggedExaSearch(exa, query, {
      type: 'auto',
      numResults: 5,
      ...opts,
      contents: { highlights: true },
    }, { exhibitionId, functionName: stage })
    const results = res.results as unknown as PoolResult[]
    console.log(`Exa ${stage} [${query}]:`, results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate })))
    return results.map((r) => ({ ...r, contentPriority: SOLO_STAGE_PRIORITY[stage], stage }))
  }

  const [s1, s2, s3] = await Promise.all([
    search('S1', `${withContext} artist`, { startPublishedDate: windowStart }),
    search('S2', `${withContext} artist practice body of work critical essay interview`, { startPublishedDate: windowStart }),
    disambiguator
      ? search('S3', `${withContext} artist`, { startPublishedDate: windowStart, includeDomains: SOLO_PRESS_DOMAINS })
      : Promise.resolve([]),
  ])
  if (!disambiguator) console.log(`Exa S3 skipped [${artist}]: no disambiguator`)

  // One pool, first stage wins a duplicate URL (S2 is listed first so an article both
  // searches found keeps S2's higher priority).
  type SoloCandidate = PoolResult & { title: string; stage: SoloStage }
  const seen = new Set<string>()
  const dedupe = (rows: (PoolResult & { stage: SoloStage })[]): SoloCandidate[] => {
    const out: SoloCandidate[] = []
    for (const r of rows) {
      if (seen.has(r.url) || !passesMechanical(r)) continue
      seen.add(r.url)
      out.push(r as SoloCandidate)
    }
    return out
  }

  let pool = dedupe([...s2, ...s1, ...s3])
  const verified = new Map<string, VerifiedCandidate>()
  const checkAndKeep = async (candidates: SoloCandidate[]): Promise<SoloCandidate[]> => {
    if (candidates.length === 0) return []
    const v = await verifyArtist(candidates)
    for (const [url, verdict] of v ?? []) verified.set(url, verdict)
    const kept = applyQualityGate(candidates, v)
    console.log(`Substantially-about verification [${artist}${disambiguator ? `, described as ${disambiguator}` : ''}]: ${kept.length} of ${candidates.length} kept`)
    return kept
  }
  pool = await checkAndKeep(pool)

  // S4 — only once the show has been open 14 days. Otherwise the daily cron runs it.
  let showReview: (PoolResult & { title: string })[] = []
  const showReviewAttempt: ShowReviewAttempt = { ran: false, result: null }
  if (exhibition.show_review_due) {
    showReviewAttempt.ran = true
    try {
      const s4 = await searchShowReview(exa, showTitle, exhibition.venue_name, isValid, 1, 1, exhibition.press_release, venueDomain, exhibitionId, { artists: exhibition.artists })
      showReview = s4.rows
      showReviewAttempt.result = showReviewResult(s4)
    } catch (err) {
      console.error(`S4 show review failed [${showTitle}]:`, err)
      showReviewAttempt.result = 'error'
    }
  } else {
    console.log(`Exa S4 skipped [${showTitle}]: show review not due yet (14 days after opening)`)
  }

  // S5 — S1 and S2 both empty after the check, and a non-fine-art disambiguator.
  const s1s2Kept = pool.filter((r) => r.stage === 'S1' || r.stage === 'S2').length
  if (s1s2Kept === 0 && isNonFineArtDisambiguator(disambiguator)) {
    const s5 = await search('S5', `${withContext} interview profile`, { includeDomains: SOLO_CROSSOVER_DOMAINS })
    pool = [...pool, ...await checkAndKeep(dedupe(s5))]
  } else {
    console.log(`Exa S5 skipped [${artist}]: ${s1s2Kept > 0 ? `S1/S2 kept ${s1s2Kept}` : 'no non-fine-art disambiguator'}`)
  }

  // Sort: on the 22-domain list first → which search found it → content type →
  // standalone-artist signal → recency.
  const CONTENT_TYPE_RANK: Record<CandidateContentType, number> = {
    interview: 0, profile: 0, review: 1, news: 2, other: 2,
  }
  pool.sort((a, b) => {
    const listDiff = (isOnDomainList(a.url, SOLO_PRESS_DOMAINS) ? 0 : 1) - (isOnDomainList(b.url, SOLO_PRESS_DOMAINS) ? 0 : 1)
    if (listDiff !== 0) return listDiff
    if (a.contentPriority !== b.contentPriority) return a.contentPriority - b.contentPriority
    const typeDiff = CONTENT_TYPE_RANK[verified.get(a.url)?.contentType ?? 'other'] - CONTENT_TYPE_RANK[verified.get(b.url)?.contentType ?? 'other']
    if (typeDiff !== 0) return typeDiff
    const aStandalone = isStandaloneArticle(a.title, artist) ? 0 : 1
    const bStandalone = isStandaloneArticle(b.title, artist) ? 0 : 1
    if (aStandalone !== bStandalone) return aStandalone - bStandalone
    const dateA = a.publishedDate ? new Date(a.publishedDate).getTime() : 0
    const dateB = b.publishedDate ? new Date(b.publishedDate).getTime() : 0
    return dateB - dateA
  })

  // Up to 3 artist pieces, one per registrable domain (avoids e.g. 3 Hyperallergic
  // pieces), plus the show review when S4 found one.
  const seenDomains = new Set<string>()
  const top3: SoloCandidate[] = []
  for (const r of pool) {
    const domain = registrableDomain(r.url)
    if (seenDomains.has(domain)) continue
    seenDomains.add(domain)
    top3.push(r)
    if (top3.length === 3) break
  }
  const reviewRows = showReview.filter((r) => !top3.some((t) => t.url === r.url))
  const prereads = [...reviewRows, ...top3].map(toPrereadRow)

  console.log(`Exa selected [${showTitle}]:`, prereads.map((p) => ({ title: p.article_title, pub: p.publication, url: p.article_url })))

  return {
    prereads, hasShowCoverage: showReview.length > 0, blocked: null, showReview: showReviewAttempt,
    showReviewUrls: reviewRows.map((r) => r.url),
  }
}

/**
 * The show review on its own (gallery solo's S4, and small and large group's) — what the daily
 * show-review cron runs for a show whose 14 days are up. Same search, pre-filter and
 * check as the inline run. Throws if the venue blocklist can't be read.
 */
export async function searchGalleryShowReview(ctx: PrereadRepairContext): Promise<{ rows: PrereadRow[]; result: ShowReviewResult }> {
  const exa = new Exa(process.env.EXA_API_KEY!)
  const galleryDomains = await buildGalleryBlocklist()
  const isValid = (r: PoolResult): r is PoolResult & { title: string } =>
    !!r.title?.trim() && !isBlockedUrl(r.url, galleryDomains)
  const venueDomain = ctx.venue_url ? getResultDomain(ctx.venue_url) || null : null
  const s4 = await searchShowReview(exa, ctx.show_title, ctx.venue_name, isValid, 1, 1, ctx.press_release, venueDomain, ctx.exhibition_id, { artists: ctx.artists })
  return { rows: s4.rows.map(toPrereadRow), result: showReviewResult(s4) }
}

// Anything stored is 'found' — even if a later call failed. Nothing stored is an
// error only if a search call never answered; a clean empty answer is 'empty'.
function showReviewResult(s4: { rows: unknown[]; searchFailed: boolean }): ShowReviewResult {
  if (s4.rows.length > 0) return 'found'
  return s4.searchFailed ? 'error' : 'empty'
}

// ─── Museum group show (0 or 2+ artists): the show review ────────────────────
//
// One show-level search, unrestricted, gated 14 days after opening like every gallery
// show (the same show_review_* columns and cron). No per-artist searches.
//
//   1. self-sourced checks — the museum's own site, any known venue, an artist's own
//      domain — before anything else
//   2. mechanical anchor:
//        a reliable artist is listed → the result names one of them AND the museum
//        no reliable artist (e.g. 0 artists) → the result names the show AND the museum
//   3. AI check grounded in the show's press release (always, on every survivor)
//   4. sort by the 22-outlet list, keep up to 3
//
// A candidate the check never judged is kept with quality_flag 'unverified', which the
// database blanks on insert (migration_v53) — same as every gallery path.

export const MUSEUM_GROUP_REVIEW_CAP = 3

export interface MuseumShowReviewContext {
  exhibition_id: string | null
  show_title: string
  artists: string[]
  press_release: string | null
  venue_name: string
  institution_name?: string | null
  venue_url: string | null
}

// Words that name a kind of place rather than this one. "Whitney Museum" still anchors
// on "whitney"; "New Museum", whose words are all generic, anchors on its full name.
const GENERIC_VENUE_WORDS = new Set([
  'the', 'museum', 'of', 'art', 'arts', 'and', 'in', 'at', 'for', 'gallery', 'galleries',
  'collection', 'center', 'centre', 'institute', 'foundation', 'house', 'new', 'york', 'nyc',
  'american', 'national', 'modern', 'contemporary', 'society', 'madison', 'fifth', 'avenue',
])

// Short names reviews spell out (or the reverse). Keyed by the normalized venue or
// institution name as stored.
const VENUE_ALIASES: Record<string, string[]> = {
  'moma': ['museum of modern art', 'moma'],
  'moma ps1': ['moma ps1', 'ps1'],
  'mad museum': ['museum of arts and design', 'mad museum'],
  'the met': ['metropolitan museum', 'the met'],
  'the metropolitan museum of art': ['metropolitan museum', 'the met'],
  'frick madison': ['frick'],
  'the frick collection': ['frick'],
  'whitney museum': ['whitney'],
  'guggenheim museum': ['guggenheim'],
  'studio museum in harlem': ['studio museum'],
}

/** The phrases that count as naming the venue: full names, aliases, distinctive words. */
export function venueAnchorPhrases(names: (string | null | undefined)[]): string[] {
  const phrases = new Set<string>()
  for (const raw of names) {
    const name = raw?.trim()
    if (!name) continue
    const norm = normalizeForMatch(name).trim()
    phrases.add(norm)
    for (const a of VENUE_ALIASES[norm] ?? []) phrases.add(a)
    // A single distinctive word (4+ letters) is enough: "Whitney", "Guggenheim", "Frick".
    for (const w of norm.split(' ')) {
      if (w.length >= 4 && !GENERIC_VENUE_WORDS.has(w)) phrases.add(w)
    }
  }
  return [...phrases]
}

export function mentionsVenue(text: string, venueNames: (string | null | undefined)[]): boolean {
  const norm = normalizeForMatch(text)
  return venueAnchorPhrases(venueNames).some((p) => containsPhrase(norm, p))
}

// An artist name the anchor can lean on: at least two significant name parts. A
// mononym or one-word collective ("Aziz", "Studio") matches far too much text.
export function isReliableArtistName(name: string): boolean {
  return significantNameParts(name).length >= 2
}

// Every significant part of the name, whole-word — the same rule as isAboutArtist.
function mentionsArtist(text: string, artist: string): boolean {
  const parts = significantNameParts(artist)
  return parts.length > 0 && parts.every((p) => containsWholeWord(text, p))
}

const TITLE_STOPWORDS = new Set(['the', 'and', 'for', 'from', 'with', 'into', 'of', 'a', 'an', 'in', 'on', 'to', 'at'])

// Fuzzy title match: the full title, or the part either side of a colon/dash (4+
// characters), or — for a title of 3+ significant words — at least 3 in 4 of those
// words present. Reviews shorten long museum titles ("Buddha and Shiva, Lotus and
// Dragon" for the whole "…: Celebrating 70 Years of…").
export function mentionsShowTitle(text: string, showTitle: string): boolean {
  const norm = normalizeForMatch(text)
  const segments = showTitle.split(/\s*[:|–—]\s*/).map((p) => p.trim()).filter((p) => p.length >= 4)
  if ([showTitle, ...segments].some((t) => containsPhrase(norm, t))) return true
  const words = normalizeForMatch(showTitle).trim().split(' ').filter((w) => w.length > 2 && !TITLE_STOPWORDS.has(w))
  if (words.length < 3) return false
  const present = words.filter((w) => norm.includes(` ${w} `)).length
  return present / words.length >= 0.75
}

export type MuseumAnchor = 'artist_venue' | 'title_venue'

/** Which anchor a museum group show uses: an artist when a reliable one is listed, else the title. */
export function museumAnchorFor(artists: string[]): MuseumAnchor {
  return artists.some(isReliableArtistName) ? 'artist_venue' : 'title_venue'
}

export function passesMuseumAnchor(
  r: { title: string | null; highlights?: string[]; text?: string },
  ctx: Pick<MuseumShowReviewContext, 'show_title' | 'artists' | 'venue_name' | 'institution_name'>
): boolean {
  const text = [r.title ?? '', ...(r.highlights ?? []), r.text ?? ''].join(' ')
  if (!mentionsVenue(text, [ctx.venue_name, ctx.institution_name])) return false
  if (museumAnchorFor(ctx.artists) === 'artist_venue') {
    return ctx.artists.filter(isReliableArtistName).some((a) => mentionsArtist(text, a))
  }
  return mentionsShowTitle(text, ctx.show_title)
}

const MUSEUM_REVIEW_TEXT_CHARS = 4000

/**
 * The museum group show's review search. Throws if the venue blocklist can't be read;
 * a failed Exa call is reported as result 'error', never as an empty search.
 */
export async function searchMuseumGroupShowReview(
  ctx: MuseumShowReviewContext,
  exaClient?: Exa
): Promise<{ rows: PrereadRow[]; result: ShowReviewResult; anchor: MuseumAnchor }> {
  const exa = exaClient ?? new Exa(process.env.EXA_API_KEY!)
  const anchor = museumAnchorFor(ctx.artists)
  const galleryDomains = await buildGalleryBlocklist()
  const venueDomain = ctx.venue_url ? getResultDomain(ctx.venue_url) || null : null

  const query = `${ctx.show_title} ${ctx.venue_name} exhibition review`
  const res = await loggedExaSearch(exa, query, {
    type: 'auto',
    numResults: 10,
    contents: { highlights: true, text: { maxCharacters: MUSEUM_REVIEW_TEXT_CHARS } },
  }, { exhibitionId: ctx.exhibition_id, functionName: 'searchMuseumGroupShowReview' })

  type Raw = PoolResult & { text?: string }
  const raw = (res.results as unknown as Raw[])
  const selfSourced = raw.filter((r) => isBlockedUrl(r.url, galleryDomains)
    || isSelfSourcedByVenue(r.url, venueDomain)
    || ctx.artists.some((a) => isSelfSourcedByArtistDomain(r.url, a)))
  const pool = raw.filter((r): r is Raw & { title: string } => !!r.title?.trim() && !selfSourced.includes(r))
  const anchored = pool.filter((r) => passesMuseumAnchor(r, ctx))
  console.log(`Museum group review [${ctx.show_title}]: ${raw.length} found, ${selfSourced.length} self-sourced/blocked, ${anchored.length} passed the ${anchor} anchor`)

  let kept: (PoolResult & { title: string })[] = anchored.map((r) => ({ ...r, contentPriority: 0 as const }))
  if (kept.length > 0) {
    const verified = await verifySubstantiallyAbout(
      `the exhibition "${ctx.show_title}" at ${ctx.venue_name}`,
      ctx.press_release,
      kept,
      { sourceKind: 'show_press_release' }
    )
    kept = applyQualityGate(kept, verified)
    console.log(`Museum group review check [${ctx.show_title}]: ${kept.length} of ${anchored.length} kept`)
  }

  const rows = [...kept]
    .sort((a, b) => pressDomainRank(a.url) - pressDomainRank(b.url))
    .slice(0, MUSEUM_GROUP_REVIEW_CAP)
    .map((r) => ({ ...toPrereadRow(r), summary: null, item_coverage_type: 'show_coverage' as const }))

  const result: ShowReviewResult = rows.length > 0 ? 'found' : res.error ? 'error' : 'empty'
  return { rows, result, anchor }
}

// ─── Single-row repair (Agent 2 retry, admin Replace) ─────────────────────────
// Everything above generates a whole set for a show. A repair works on ONE stored
// row: first re-check the article already there (cheap — one Haiku call, no search),
// and only if that fails look for a replacement. Both reuse the same gates the set
// generators use (blocklist, self-sourced checks, verifySubstantiallyAbout), so a
// repaired row clears exactly the bar a freshly generated one would.
//
// Gallery rows, and museum rows through `museum` below — each museum show type is
// repaired with its own search and check. Fair coverage still has no quality check.

/**
 * Which museum search and check a museum show's rows are repaired with:
 *   solo_contemporary  the gallery solo ladder's — an artist row is checked and
 *                      replaced like a gallery solo row, a show_coverage row like S4
 *   solo_historical    the same as group_show: the show review is all it gets
 *   group_show         the group show's search and venue + artist/title anchor, checked
 *                      against the press release; every row is about the show
 */
export type MuseumRepairKind = 'solo_contemporary' | 'solo_historical' | 'group_show'

export interface PrereadRepairContext {
  exhibition_id: string
  show_title: string
  artists: string[]
  press_release: string | null
  venue_name: string
  venue_url: string | null
  // Filled in on first use by artistIdentity, so a repair pass over several rows of
  // one show extracts each artist's disambiguator once, not once per row.
  identityCache?: Map<string, Promise<ArtistIdentity>>
  // Museum shows only; absent means a gallery show.
  museum?: { kind: MuseumRepairKind; institution_name: string | null }
}

export interface ArtistIdentity {
  disambiguator: string | null
  bio: string | null
}

// The same disambiguator the generators use: from the artist's bio when there is one
// (Haiku), else the press release (Sonnet). One call per artist per repair pass.
function artistIdentity(ctx: PrereadRepairContext, name: string): Promise<ArtistIdentity> {
  ctx.identityCache ??= new Map()
  let pending = ctx.identityCache.get(name)
  if (!pending) {
    pending = (async () => {
      const bios = await fetchArtistBios([name])
      const context = await extractArtistSearchContext(ctx.press_release, [name], bios)
      return { disambiguator: context.get(name)?.trim() || null, bio: bios.get(name) ?? null }
    })()
    ctx.identityCache.set(name, pending)
  }
  return pending
}

// Checks repair candidates against a row's subject: an artist exactly as the ladder
// does (verifyArtistCandidates); a show against its press release, as before.
async function verifyForSubject<T extends PoolResult & { title: string }>(
  ctx: PrereadRepairContext,
  subject: PrereadSubject,
  candidates: T[]
): Promise<Map<string, VerifiedCandidate> | null> {
  if (subject.kind === 'show') {
    // Museum show rows get the same press-release grounding as the museum generators
    // (group review, S4); gallery show rows keep theirs.
    return verifySubstantiallyAbout(subjectLabel(ctx, subject), ctx.press_release, candidates,
      ctx.museum ? { sourceKind: 'show_press_release' } : {})
  }
  const { disambiguator, bio } = await artistIdentity(ctx, subject.name)
  return verifyArtistCandidates(subject.name, disambiguator, bio, ctx.press_release, candidates)
}

/** What a row is about: one artist, or the show as a whole. */
export type PrereadSubject = { kind: 'artist'; name: string } | { kind: 'show' }

// A row's subject follows how it was generated: per-artist rows carry artist_name;
// a solo show's rows don't, but every one of them is about that one artist; anything
// else is a show-level (show review) row. Museum rows go by the show type instead:
// only a contemporary solo show has artist rows, and its show review is labelled
// show_coverage.
export function prereadSubject(
  ctx: PrereadRepairContext,
  artistName: string | null | undefined,
  itemCoverageType?: string | null
): PrereadSubject {
  if (ctx.museum) {
    return ctx.museum.kind === 'solo_contemporary' && itemCoverageType !== 'show_coverage'
      ? { kind: 'artist', name: ctx.artists[0] }
      : { kind: 'show' }
  }
  if (artistName) return { kind: 'artist', name: artistName }
  if (ctx.artists.length === 1) return { kind: 'artist', name: ctx.artists[0] }
  return { kind: 'show' }
}

function subjectLabel(ctx: PrereadRepairContext, subject: PrereadSubject): string {
  return subject.kind === 'artist' ? `the artist "${subject.name}"` : `the exhibition "${ctx.show_title}" at ${ctx.venue_name}`
}

function isSelfSourcedFor(url: string, ctx: PrereadRepairContext, subject: PrereadSubject): boolean {
  const venueDomain = ctx.venue_url ? getResultDomain(ctx.venue_url) || null : null
  if (isSelfSourcedByVenue(url, venueDomain)) return true
  const names = subject.kind === 'artist' ? [subject.name] : ctx.artists
  return names.some((n) => isSelfSourcedByArtistDomain(url, n))
}

/**
 * Re-runs the quality check on an article already stored. 'pass' means the row is
 * fine as it is; otherwise the flag it should carry. Throws only if the database
 * lookup for the artist bio throws — a failed check is 'unverified', not an error.
 */
export async function recheckPreread(
  ctx: PrereadRepairContext,
  row: { article_url: string | null; article_title: string | null; summary: string | null; artist_name?: string | null; item_coverage_type?: string | null }
): Promise<'pass' | QualityFlag> {
  if (!row.article_url) return 'mismatched'
  const subject = prereadSubject(ctx, row.artist_name, row.item_coverage_type)
  if (isSelfSourcedFor(row.article_url, ctx, subject)) return 'self_sourced'

  const candidate: PoolResult & { title: string } = {
    url: row.article_url,
    title: row.article_title ?? row.article_url,
    highlights: row.summary ? [row.summary] : [],
    contentPriority: subject.kind === 'show' ? 0 : 1,
  }
  const verified = await verifyForSubject(ctx, subject, [candidate])
  const gate = qualityGate(verified, candidate.url)
  if (gate === 'pass') return 'pass'
  if (gate === 'unverified') return 'unverified'
  // A show-level row that isn't about this show can still be about one of its artists,
  // and then it belongs:
  //   - contemporary museum solo: the ladder takes artist pieces as well as show
  //     reviews, and the old museum search labelled many artist pieces show_coverage
  //   - museum group show: rows the old per-artist tiers stored (anything not labelled
  //     show_coverage) are checked as pieces about the artist they name
  // The artist is the row's own artist_name, else the first of the show's artists its
  // title/summary names; a row that names none of them is judged as a show row only.
  const artistFallback = subject.kind !== 'show' ? null
    : ctx.museum?.kind === 'solo_contemporary' ? ctx.artists[0]
      : ctx.museum?.kind === 'group_show' && row.item_coverage_type !== 'show_coverage'
        ? (row.artist_name && ctx.artists.includes(row.artist_name) ? row.artist_name
          : ctx.artists.find((a) => significantNameParts(a).length > 0 && isAboutArtist(candidate, a)) ?? null)
        : null
  if (artistFallback) {
    const asArtist: PrereadSubject = { kind: 'artist', name: artistFallback }
    if (!isSelfSourcedFor(row.article_url, ctx, asArtist)) {
      const artistVerified = await verifyForSubject(ctx, asArtist, [{ ...candidate, contentPriority: 1 }])
      if (qualityGate(artistVerified, candidate.url) === 'pass') return 'pass'
    }
  }
  return rejectionFlag(verified!.get(candidate.url)!)
}

export type ReplacementResult =
  | { ok: true; row: PrereadRow }
  /** `flag` is why the best candidate failed, or null if the search found nothing usable at all. */
  | { ok: false; flag: QualityFlag | null; query: string }

/**
 * Searches for one replacement article for `subject`. `customQuery`, when given, is
 * used verbatim instead of the default query — the admin's "custom search" Replace
 * mode. Only a candidate that PASSES the check is returned; an unverified one is a
 * failed repair (flag 'unverified'), not a replacement, since swapping one unchecked
 * article for another fixes nothing. Throws if the Exa search throws.
 */
export async function findReplacementPreread(
  ctx: PrereadRepairContext,
  subject: PrereadSubject,
  excludeUrls: Set<string>,
  customQuery?: string | null
): Promise<ReplacementResult> {
  const exa = new Exa(process.env.EXA_API_KEY!)
  const custom = customQuery?.trim() || null
  const museumKind = subject.kind === 'show' ? ctx.museum?.kind : undefined
  // Group and historical solo shows are both searched the way the group review is.
  const museumGroupSearch = museumKind === 'group_show' || museumKind === 'solo_historical'
  // The default search is the one that generated this kind of row: the museum group
  // review search (group and historical solo shows), or gallery's (also contemporary
  // museum solo's). A custom query is used as typed.
  const query = custom
    || (subject.kind === 'artist' ? `${subject.name} artist interview profile`
      : museumGroupSearch ? `${ctx.show_title} ${ctx.venue_name} exhibition review`
        : `${ctx.show_title} ${ctx.venue_name} review exhibition`)

  const res = await loggedExaSearch(exa, query, {
    type: 'auto',
    numResults: 8,
    // The group anchor reads page text, as the group search does.
    contents: !custom && museumGroupSearch
      ? { highlights: true, text: { maxCharacters: MUSEUM_REVIEW_TEXT_CHARS } }
      : { highlights: true },
  }, { exhibitionId: ctx.exhibition_id, functionName: custom ? 'replacePrereadCustom' : 'repairPreread' })

  const galleryDomains = await buildGalleryBlocklist()
  const results = (res.results as unknown as PoolResult[]).map((r) => ({ ...r, contentPriority: (subject.kind === 'show' ? 0 : 1) as 0 | 1 }))

  let droppedAsSelfSourced = 0
  const candidates: (PoolResult & { title: string })[] = []
  for (const r of results) {
    if (!r.title?.trim() || excludeUrls.has(r.url) || isBlockedUrl(r.url, galleryDomains)) continue
    if (isSelfSourcedFor(r.url, ctx, subject)) { droppedAsSelfSourced++; continue }
    // The name check is skipped for a custom query: the admin chose those terms on
    // purpose, and the comprehension check below still guards aboutness.
    if (!customQuery?.trim() && subject.kind === 'artist' && !isAboutArtist(r, subject.name)) continue
    // Same for the museum group show's venue + artist/title anchor.
    if (!custom && museumGroupSearch
      && !passesMuseumAnchor(r as PoolResult & { text?: string }, { ...ctx, institution_name: ctx.museum?.institution_name })) continue
    candidates.push(r as PoolResult & { title: string })
  }

  if (candidates.length === 0) {
    return { ok: false, flag: droppedAsSelfSourced > 0 ? 'self_sourced' : null, query }
  }

  const ranked = sortByTierAndRecency(candidates)
  const verified = await verifyForSubject(ctx, subject, ranked)
  if (!verified) return { ok: false, flag: 'unverified', query }

  const best = ranked.find((r) => qualityGate(verified, r.url) === 'pass')
  if (best) {
    const row = toPrereadRow({ ...best, artistName: subject.kind === 'artist' && ctx.artists.length > 1 ? subject.name : null })
    // Museum rows carry their kind: the public museum page orders by it.
    return { ok: true, row: ctx.museum ? { ...row, item_coverage_type: subject.kind === 'show' ? 'show_coverage' : 'artist_profile' } : row }
  }

  const judged = ranked.map((r) => verified.get(r.url)).find((v): v is VerifiedCandidate => !!v)
  return { ok: false, flag: judged ? rejectionFlag(judged) : 'unverified', query }
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

Use "other" ONLY when the address, title or URL names a specific place outside NYC (e.g. Venice Biennale, Art Basel Miami, London, Paris, LA).
Use "nyc" for everything else, including community/partner/education programs, teen or outreach initiatives, and any name that merely sounds like it could involve another site without naming one — these are frequently presented at the institution's own NYC building. Default to "nyc" whenever there's no explicit non-NYC place name.

Some exhibitions include "location_hint": the place text printed next to the link on the listing page — a city, a neighbourhood, a branch name, or "on view at ..." phrasing. Weigh it ahead of the title and URL, which often say nothing about where a show is:
- A hint naming a place outside New York City ("London", "Los Angeles", "Aspen", "Seoul") → "other".
- A hint naming a New York City place, borough or branch ("Chelsea", "Tribeca", "19th Street", "New York") → "nyc".
- A hint that names no place, or only a gallery's own branch label you cannot place, decides nothing on its own — fall back to the rules below.

Some exhibitions include "addresses": street addresses shown next to the link on the listing page. When present they are the strongest evidence:
- Any address in New York City (Manhattan, Brooklyn, Queens, the Bronx, Staten Island, or a New York City zip code) → "nyc", even if the title names another place.
- Addresses that are all in another city, state or country → "other".
- A street named after a place ("Hudson Street", "Greenwich Street", "Boston Road") is not that place.

Exhibitions:
${JSON.stringify(links.map((l) => ({
  url: l.url,
  title: l.title,
  ...(l.location_hint ? { location_hint: l.location_hint } : {}),
  ...(l.addresses.length ? { addresses: l.addresses } : {}),
})))}`,
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

/**
 * Orders candidates by which close soonest, for the cap.
 *
 * Judgment, not parsing. The listing text this reads is free-form — "Through Jan 2,
 * 2027", "Apr 24, 2026–Fall 2026", "Ongoing from Oct 19" — and mechanically
 * resolving that into dates at this stage is the bug that once dropped 18 real MoMA
 * shows. A wrong ordering here only means a slightly worse choice of which shows to
 * fetch first; it never drops one.
 *
 * Fails open in every direction: any error, unparseable reply or missing URL leaves
 * the original order, which is what this stage used before ranking existed.
 */
export async function rankLinksBySoonestClosing(
  links: ExhibitionLink[],
  institutionName: string,
  today = new Date().toISOString().split('T')[0]
): Promise<ExhibitionLink[]> {
  if (links.length < 2) return links

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `These exhibitions are all listed by ${institutionName}. Order them by which closes soonest, so the most urgent come first.

Today: ${today}

Use your judgement on the date text as written — it is copied verbatim off the listing page and is often incomplete ("Through Jan 2", "Sep 3, 2026—Spring 2027", "Ongoing"). Do not try to convert it into exact dates.
- A show closing sooner comes before one closing later.
- A show with no stated end ("Ongoing", "long-term view") goes last — nothing about it is urgent.
- A show whose date text says nothing useful, or that has none, goes after the dated ones but before the ongoing ones.

Return ONLY a JSON array of every url, in your chosen order, no markdown:
["https://...", "https://..."]

Exhibitions:
${JSON.stringify(links.map((l) => ({ url: l.url, title: l.title, dates: l.date_hint })))}`,
        },
      ],
    })

    const text = response.content.find((b) => b.type === 'text')?.text ?? ''
    const order = extractJsonArray<string>(text)
    if (!order) return links

    const byUrl = new Map(links.map((l) => [l.url, l]))
    const ranked: ExhibitionLink[] = []
    for (const url of order) {
      const link = typeof url === 'string' ? byUrl.get(url) : undefined
      if (link && !ranked.includes(link)) ranked.push(link)
    }
    // Anything the model left out keeps its original position at the back, so a
    // partial answer can never lose a candidate.
    for (const link of links) if (!ranked.includes(link)) ranked.push(link)
    return ranked
  } catch (err) {
    console.error('rankLinksBySoonestClosing failed — keeping listing order:', err)
    return links
  }
}

// ─── Address agreement (check #10) ────────────────────────────────────────────
// Reached only when normalization (lib/address-normalize.ts) can't show that the
// listing-page and show-page addresses are the same. Fails closed: an error reads
// as 'different', which holds the show for review instead of publishing a
// possible mismatch.

export async function judgeSameAddress(a: string, b: string): Promise<'same' | 'different'> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 5,
      messages: [
        {
          role: 'user',
          content: `Do these two strings describe the same street address?

Count them as the same when they differ only in formatting: abbreviations, punctuation, a floor or suite, a building's address range (e.g. "535-537" vs "537"), or a missing city, state or zip.
Count them as different when they name a different street, or a different building on the same street.

Answer only "same" or "different".

A: ${a}
B: ${b}`,
        },
      ],
    })
    const answer = response.content.find((block) => block.type === 'text')?.text?.toLowerCase().trim() ?? ''
    return answer.startsWith('same') ? 'same' : 'different'
  } catch (err) {
    console.error(`judgeSameAddress failed for "${a}" / "${b}":`, err)
    return 'different'
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
// srcset and its lazy-loading cousins carry long repeating URL lists that crowd
// out the text the anchor window exists to capture. Measured share of a real
// Tier 1 input: 49% at Aicon Art, 26% Friedman Benda, 24% Bortolami, 18% Zwirner.
//
// The spelling varies by how the page reached us: a Browserbase-rendered DOM
// serialises lowercase `srcset`, while React SSR emits `srcSet`, so matching is
// case-insensitive. Casey Kaplan uses `data-src` instead.
//
// Only attributes whose value actually looks like image URLs are dropped, so a
// data-src holding something else is left intact. This lives here rather than in
// extractMainContent because that helper is shared with detail-page extraction,
// which still needs image URLs to populate image_url.
const IMAGE_URL_ATTRS =
  /\s(?:imagesrcset|data-srcset|data-lazy-src|data-original|srcset|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

// Plain `src` needs a stricter test than the multi-URL attributes above: a bare
// "is this a URL" check would also match <script src> and <iframe src>, which are
// structural. Requiring an image file extension (query string allowed, as CDNs
// append resize params) keeps it to images only. Worth doing because these sit
// immediately after the anchor — Bortolami's cards are <a><figure><img src=…>,
// putting ~29KB of CDN URLs in the highest-value position in the window.
const IMAGE_SRC_ATTR = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const IMAGE_FILE_URL = /\.(?:jpe?g|png|webp|avif|gif)(?:[?&#]|$)/i

// Inline styles carrying a data: URI — base64 or percent-encoded SVG used as a
// blur-up placeholder behind a lazy-loaded image. On Zwirner these are the single
// largest thing between a card's anchor and its own title/location text (1,303 of
// a 2,259-character gap). Only styles containing a data: URI are removed, and only
// the style attribute itself: class attributes are deliberately left alone, since
// class names can carry state Tier 1's classification may be reading.

const DATA_URI_STYLE_ATTR = /\sstyle\s*=\s*(?:"[^"]*data:[^"]*"|'[^']*data:[^']*')/gi

function stripImageUrlNoise(html: string): string {
  return html
    .replace(IMAGE_URL_ATTRS, (match, dq: string | undefined, sq: string | undefined) => {
      const value = dq ?? sq ?? ''
      const looksLikeImageUrls =
        /https?:\/\/|\.(?:jpe?g|png|webp|avif|gif|svg)|\d+w(?:,|\s*$)/i.test(value)
      return looksLikeImageUrls ? ' ' : match
    })
    .replace(IMAGE_SRC_ATTR, (match, dq: string | undefined, sq: string | undefined) => {
      const value = dq ?? sq ?? ''
      return IMAGE_FILE_URL.test(value) ? ' ' : match
    })
    .replace(DATA_URI_STYLE_ATTR, ' ')
}

function extractAnchorContext(rawHtml: string, baseUrl: string, contextChars = 600): string {
  // Strip before windowing, not after: the point is for more real text to fall
  // inside the window, not to clean it up once the boilerplate has already
  // displaced that text.
  const html = stripImageUrlNoise(rawHtml)

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
  venueUrl: string,
  // Operator note from venues.scrape_notes. Free text rather than a selector on
  // purpose: a stale selector fails silently and misdirects, whereas a stale
  // note is weighed as one piece of evidence among several and degrades into
  // noise. Framed below as a hint, not an override, so it cannot on its own
  // reclassify a Program as an exhibition.
  scrapeNotes?: string | null,
  // MINIMUM anchor-context half-width, not the value used. The pre-pass below
  // sizes the window to this page's own worst link-to-date distance; this floor
  // is how the location_hint retry ladder widens it further for a multi-city
  // institution whose links come back with no location_hint.
  contextChars = 600
): Promise<ExhibitionLink[]> {
  const today = new Date().toISOString().split('T')[0]

  // One pure pass over the real page, before the call, so all three limits are
  // sized to the page in front of us. Flat limits were failing silently: a
  // response that hit the old 4,096-token ceiling stopped mid-array and the
  // parser read the unterminated JSON as zero links.
  const main = extractMainContent(html)
  const analysis = analyzeListingPage(stripImageUrlNoise(main), venueUrl)
  const sizing = sizingFor(analysis)
  // The ladder's rung is a floor on the window, never a cap on it.
  const windowChars = Math.max(sizing.contextChars, contextChars)
  const stripped = extractAnchorContext(main, venueUrl, windowChars).slice(0, sizing.pageCutoff)

  console.log(JSON.stringify({
    tag: 'AGENT1', venue: venueName, event: 'T1_SIZING',
    page_chars: analysis.pageChars,
    links_found: analysis.linkCount,
    boundary: analysis.boundaryIndex !== null,
    links_before_boundary: analysis.linksBeforeBoundary,
    max_date_distance: analysis.maxDistance,
    window: windowChars,
    page_cutoff: sizing.pageCutoff,
    sent_chars: stripped.length,
    max_tokens: sizing.maxTokens,
    skip_past_section: sizing.skipPastSection,
    basis: sizing.basis,
  }))

  const notesBlock = scrapeNotes?.trim()
    ? `\nNote from the site's operator about this page — treat as a hint about where to look, not as a rule that overrides the classification below:\n${scrapeNotes.trim()}\n`
    : ''

  // Only ever set when the page has a real archive heading with shows above it.
  // Paired with the output ceiling: that ceiling is sized to the links above the
  // heading, and truncation does not return the first N links — it returns an
  // unterminated array the parser reads as none. So the two move together.
  const skipPastBlock = sizing.skipPastSection
    ? `\nThis page has a "Past"/"Archive" section further down. Return ONLY the exhibitions listed ABOVE that heading, and skip every link below it. Those are closed shows that are discarded later anyway, and including them makes the reply long enough to be cut off — which loses the entire page, not just the closed shows.\n`
    : ''

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: sizing.maxTokens,
    messages: [
      {
        role: 'user',
        content: `Extract all exhibition links from this ${venueName} listing page (${venueUrl}).

Today: ${today}
${notesBlock}${skipPastBlock}
For each exhibition link found, return:
- title: the exhibition or show title
- url: full absolute URL to the exhibition detail page (resolve relative URLs against base ${venueUrl})
- classification_reason: work through the evidence first (section heading, labels, explicit dates compared to today) — brief note (e.g. "labeled On View", "end date passed", "section heading: Past")
- classification: exactly one of 'current' | 'past' | 'permanent' | 'upcoming', consistent with the reasoning above
- content_type: exactly one of 'exhibition' | 'event' | 'online_only' | 'fair' | 'offsite' | 'unclear'
- location_hint: place text shown next to this link on the listing page — a city, a neighbourhood, a branch label, an address, or "on view at ..." phrasing. Copy it verbatim. Use null when no place text appears near the link. Do NOT infer a place from the gallery's name, from the artist, or from words inside the exhibition title (a show called "London Calling" at an unstated location is null, not "London")
- addresses: every street address (house number and street) shown next to this link on the listing page for where this show is on view — a list of up to 3, one address per entry, each with the floor/suite, city, state and zip that go with it, even when those are printed on a separate line. Split a line that joins two addresses ("22 Cortlandt Alley & 394 Broadway") into two entries. Use [] when none appears near the link — a city, neighbourhood or branch name alone is not an address (that belongs in location_hint). Never infer an address from the gallery's name.
- date_hint: the date text shown next to this link on the listing page, copied verbatim and whole, exactly as printed — a range ("September 18—October 31", "Sept. 17, 2026–Feb. 14, 2027"), an open-ended date ("Through January 4"), or a status word used in place of dates ("Ongoing", "On view now"). Keep the year only if the page prints it; do not add, complete or correct a year, and do not reformat. A label that comes with the dates may stay if it is part of the same text ("Coming Soon: September 18—October 31"). Use null when no date text appears near the link. Do NOT infer dates from the exhibition title, from the section heading, or from the classification you chose.

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
- 'fair': a presentation at an art fair rather than at this venue — a booth or stand at Frieze, Art Basel, NADA, The Armory Show, TEFAF, Independent, EXPO Chicago, Untitled and the like. Galleries list their fair booths among their own shows; a booth number ("Booth D12") or a fair's name next to the link is the signal. Still 'fair' even though it is this gallery's own booth — it is not on at this gallery.
- 'offsite': a show at someone else's space — a loan, a touring show, or a collaboration hosted by another institution ("on view at the Whitney", "presented at the Aldrich", "on loan to ..."). IMPORTANT: a collaboration or co-organized show that takes place at ${venueName}'s OWN space is a normal 'exhibition', not 'offsite' — the test is where the work hangs, not who organized it.
- 'unclear': cannot determine content type from the listing page alone
- When ambiguous between 'exhibition' and something else: use 'unclear', not 'exhibition'
- Trust the site's own labeling/section headings over the presence of exhibition-like details (artist name, dates, image) — a card labeled "Project" with a real artist and real dates is still not an exhibition

Return ONLY a JSON array (no markdown, no commentary):
[{"title":"...","url":"https://...","classification_reason":"...","classification":"current","content_type":"exhibition","location_hint":"New York: 19th Street","addresses":[],"date_hint":null}]

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
      content_type?: string; location_hint?: string | null; addresses?: unknown
      date_hint?: string | null
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
        content_type: (['exhibition','event','online_only','fair','offsite','unclear'].includes(item.content_type ?? '')
          ? item.content_type
          : 'unclear') as ExhibitionLink['content_type'],
        location_hint: typeof item.location_hint === 'string' && item.location_hint.trim()
          ? item.location_hint.trim()
          : null,
        addresses: cleanExtractedAddresses(item.addresses),
        // Kept as printed: parsing it here would mean re-deriving the year the
        // page left out, which is the detail stage's job (DETAIL_PROMPT) and the
        // source of a real wrong-year discard before now.
        date_hint: typeof item.date_hint === 'string' && item.date_hint.trim()
          ? item.date_hint.trim().replace(/\s+/g, ' ')
          : null,
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
        // URL-only fallback: no page text, so no place text, address or date to quote.
        location_hint: null,
        addresses: [],
        date_hint: null,
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
  // Inferred is the safe default: it is the reading that never lets a group show
  // publish names that might not be the artist list.
  show_type: 'exhibition', artist_bio: null, addresses: [], artists_inferred: true,
}

// Up to three non-empty, de-duplicated entries. A bare string is accepted too, in
// case a response slips back to the single-address shape.
function cleanExtractedAddresses(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const out: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const address = entry.trim().replace(/\s+/g, ' ')
    if (address && !out.includes(address)) out.push(address)
  }
  return out.slice(0, 3)
}

function normalizeShowType(value: unknown): ExhibitionDetailExtracted['show_type'] {
  return value === 'installation' ? 'installation' : 'exhibition'
}

const DETAIL_PROMPT = (url: string, content: string, pageTitles: string[] = []) => `Extract exhibition data from this page (${url}).

Today: ${new Date().toISOString().split('T')[0]}
${pageTitles.length > 0 ? `\nThe page's own title tags (not part of the HTML below): ${pageTitles.map((t) => JSON.stringify(t)).join(' / ')}\n` : ''}
CRITICAL RULES:
- Do NOT generate, infer, or hallucinate content not present on the page
- description must be verbatim extracted text — never AI-generated or summarized
- If a field is not on the page, return null
- title: the show's own title, in full — not whichever text is largest or first. Many pages set the artist's name as the big heading and put the show's title in a smaller heading or line just under or beside it (heading "Pierre Huyghe", then "UUmwelt"). Look for that second line before settling on the name: when the page has one, the title is the show title ("UUmwelt"), not the artist's name. The page's title tags above often spell out the full title ("Pierre Huyghe: UUmwelt | MoMA", "TARYN SIMON | FATHER COUNTRY I DO LOVE YOU") — use them to find it, but leave out the venue, city, address and dates they also carry, and take the show title's capitalization from the page text when it appears there. A title tag that only repeats the artist's name, or part of it ("Tornay — Bowery Gallery" for the artist Ian Tornay), is not a separate show title. When the page's heading is itself one combined title that includes the artist ("Andrea Bowers: Democracy Needs Our Courage"), keep it exactly as written. When neither the page nor its title tags give the show any title of its own, many shows are simply titled with the artist's name: return the name exactly as the page's heading shows it ("Ian Tornay") — never null just because the title is a name.
- Dates in YYYY-MM-DD format only
- When a date on the page has no explicit year (e.g. "Through Jul 25", "Opens March 3"), this is a listing of what the institution currently considers on view — infer the year that is consistent with that: for an end date, pick the soonest occurrence of that month/day that is on or after today; for a start date, pick the occurrence that keeps the exhibition's run plausible relative to today. Do not default to the current calendar year or the page's copyright year without this reasoning — a bare "Jul 25" read on a page today should not be assumed to have already passed just because that date earlier this year is in the past.
- The output must be valid JSON: any double-quote character that is part of extracted text (e.g. a quoted phrase copied from the page) must be escaped as \\" so it does not terminate the JSON string early
- show_type: "installation" when the page describes a site-specific, long-term, permanent, or on-view-indefinitely work/display (e.g. "long-term view", "permanent installation", "on view indefinitely", a commissioned site-specific work) — "exhibition" for a normal temporary show with a defined or expected run. Default to "exhibition" when unclear.
- artist_bio: many exhibition pages have a separate biographical section about the artist(s), often under its own heading like "About the Artist," "More About [Name]," or "Biography" — distinct from the exhibition/show description above it. Extract this verbatim if present, separately from "description." If the page has bios for multiple artists, concatenate them, each preceded by the artist's name. Null if no such section exists on the page.
- artists: only the artists of THIS exhibition. Museum and gallery pages often carry other lists of names: an "Artists" module listing everyone with work in the room, garden or wing where the show is installed; related or recommended artists; collection highlights; other shows' credits. A list — even one headed "Artists" — is this show's artist list only when it belongs to the show: it sits with the show's title and description, or its names are the ones the show's own text presents as its artists. When the show's title and description are about one artist's work (e.g. a single commission or installation), return just that artist, and do not add names that appear only in such a page-wide list.
- artists_inferred: where the names in "artists" came from. false ONLY when the page carries a dedicated artist list or credit line for THIS show — an "Artists:" block belonging to the show (see "artists" above), a byline under the show title, a list of artist names as links, a curated checklist. true when you read the names out of the exhibition title ("Andrea Bowers: Democracy Needs Our Courage") or out of the body prose. Return true when there are no artists, and true whenever you are unsure: a credit line is a specific thing to see on the page, and calling a prose mention "credited" lets a group show publish names that may not be its artist list at all.
- addresses: every street address where THIS exhibition is on view, as a list of up to 3 entries in page order — one location per entry, never two street addresses in one entry.
  • Each entry is one complete address: house number and street, any floor/suite, then city, state and zip. Include the city, state and zip even when the page prints them on a separate line or in a separate element from the street — "533 West 19th Street" followed by "New York, New York 10011" becomes "533 West 19th Street, New York, New York 10011".
  • A show held at several locations: when the page lists them as separate blocks (e.g. a "Locations" section with one labelled address each), return one entry per block. When one line joins addresses ("22 Cortlandt Alley & 394 Broadway"), split it into one entry per address, each carrying the city, state and zip they share.
  • Prefer text about the show itself (e.g. "on view at 537 West 22nd Street"). A gallery address counts only when the page shows a single gallery address; if the page lists several gallery locations (a footer, a contact block) without saying which ones host this show, return [].
  • Never infer an address from the gallery's name. [] if no street address is given.

Return ONLY a JSON object (no markdown, no commentary):
{
  "title": "exhibition title or null",
  "artists": ["artist name strings — empty array if none"],
  "artists_inferred": true,
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null",
  "date_notes": "verbatim date text that could not be parsed as YYYY-MM-DD (e.g. 'On view through summer 2025') — null if dates were fully parsed or no date info exists",
  "description": "full verbatim exhibition description or press release text — take the longest body of text about the show, do not truncate, do not summarize — null if nothing found on page",
  "image_url": "absolute URL of primary exhibition image — prefer hero/banner or og:image meta, not thumbnails/icons/logos — null if none",
  "press_release_url": "URL to a separate press release PDF or page if explicitly linked — null otherwise",
  "show_type": "exhibition" | "installation",
  "artist_bio": "verbatim biographical text about the artist(s), separate from the exhibition description — null if no such section exists",
  "addresses": ["one complete address per location: street, floor/suite, city, state, zip — [] if none"]
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
- addresses → every street address where this exhibition is on view, one per entry (up to 3), each with its city, state and zip; [] if none

The output must be valid JSON: any double-quote character that is part of extracted text (e.g. a quoted phrase copied verbatim) must be escaped as \\" so it does not terminate the JSON string early.

Return ONLY a JSON object:
{"title":"...","artists":["..."],"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD or null","date_notes":null,"description":"...","image_url":"https://...","press_release_url":null,"show_type":"exhibition","addresses":[]}

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
    // Only an explicit false means the page had a real credit line. Anything else
    // — omitted, null, unparseable — reads as inferred, which is the answer that
    // never lets a group show publish names that may not be its artist list. The
    // __NEXT_DATA__ path never asks for this field, and correctly lands here: a
    // JSON blob has no visual credit line to have read.
    artists_inferred: raw.artists_inferred !== false,
    start_date: raw.start_date ?? null,
    end_date: raw.end_date ?? null,
    date_notes: raw.date_notes ?? null,
    description: raw.description ?? null,
    image_url: raw.image_url ?? null,
    press_release_url: raw.press_release_url ?? null,
    show_type: normalizeShowType(raw.show_type),
    artist_bio: raw.artist_bio ?? null,
    addresses: cleanExtractedAddresses(raw.addresses),
  }
}

async function callClaudeForDetail(content: string, url: string, pageTitles: string[] = []): Promise<ExhibitionDetailExtracted> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: DETAIL_PROMPT(url, content, pageTitles) }],
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
    // Only an explicit false means the page had a real credit line. Anything else
    // — omitted, null, unparseable — reads as inferred, which is the answer that
    // never lets a group show publish names that may not be its artist list. The
    // __NEXT_DATA__ path never asks for this field, and correctly lands here: a
    // JSON blob has no visual credit line to have read.
    artists_inferred: raw.artists_inferred !== false,
    start_date: raw.start_date ?? null,
    end_date: raw.end_date ?? null,
    date_notes: raw.date_notes ?? null,
    description: raw.description ?? null,
    image_url: raw.image_url ?? null,
    press_release_url: raw.press_release_url ?? null,
    show_type: normalizeShowType(raw.show_type),
    artist_bio: raw.artist_bio ?? null,
    addresses: cleanExtractedAddresses(raw.addresses),
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

// The page's <title> and og:title. The content sent to the model is the page's main
// region, which never includes <head> — yet that is often the only place the full
// show title is spelled out when the page's big heading is just the artist's name
// (Guggenheim "TARYN SIMON | FATHER COUNTRY I DO LOVE YOU", MoMA "Pierre Huyghe:
// UUmwelt | MoMA"). Without them, four shows were stored under the artist's name.
export function pageTitleTags(html: string): string[] {
  const decode = (t: string) => t
    .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&#8217;|&rsquo;/g, '’').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
  const found = [
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)?.[1],
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i)?.[1],
  ]
  const titles: string[] = []
  for (const t of found) {
    const d = t ? decode(t).slice(0, 300) : ''
    if (d && !titles.includes(d)) titles.push(d)
  }
  return titles
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
  const pageTitles = pageTitleTags(html)

  let result = await callClaudeForDetail(primary, exhibitionUrl, pageTitles)

  // If title is null, retry targeting specific semantic containers —
  // handles sites where the exhibition data is in a non-standard wrapper
  if (!result.title?.trim()) {
    const focused = extractDetailFocused(cleaned).slice(0, 60000)
    if (focused.length > 1000 && focused !== primary) {
      console.log(`[extractExhibitionDetail] title null on first pass — retrying with focused content (${exhibitionUrl})`)
      const retry = await callClaudeForDetail(focused, exhibitionUrl, pageTitles)
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
    const expandedResult = await callClaudeForDetail(expanded, exhibitionUrl, pageTitles)
    const expandedLen = expandedResult.description?.trim().length ?? 0
    const currentLen = result.description?.trim().length ?? 0
    if (expandedResult.title?.trim() && expandedLen > currentLen) {
      result = expandedResult
    }
  }

  return result
}

// ─── Detail-stage location verification ───────────────────────────────────────
// The link-stage filter (filterLinksByLocation, above) only ever sees a show's
// title and URL, and is told to assume NYC when neither names a city. That is
// the right default at that stage — most galleries never put a city in either —
// but it means a show is admitted before the page that states its location has
// even been downloaded. This runs after that download, on the page itself.
//
// It exists because the evidence lives somewhere different on every site:
//   • David Zwirner puts it in the page title  — "Nocturnal | Hong Kong | ..."
//   • The Campus buries a postal address in the press release body
//   • Lisson states it in prose — "Finch's first exhibition in Los Angeles"
// so neither the title nor the body alone is sufficient; both are checked.

export type LocationVerdict = 'nyc' | 'non_nyc' | 'unknown'

export interface LocationCheck {
  verdict: LocationVerdict
  city: string | null
  evidence: string | null
  source: 'title' | 'model' | 'error'
  /** Whether the page shows this gallery operating in more than one city.
   *  Decides how much a 'unknown' verdict should worry us: a one-address New
   *  York gallery that says nothing about location is at its own address, while
   *  a gallery with branches saying nothing is genuinely ambiguous. */
  galleryMultiCity: boolean
}

const NYC_PLACE = /\b(new york|nyc|n\.y\.c|manhattan|brooklyn|queens|the bronx|bronx|staten island|harlem|tribeca|chelsea|soho|long island city|astoria|bushwick|greenpoint|williamsburg)\b/i

// Cities that appear as a bare segment in a page title mean the show is there.
// Deliberately limited to places a gallery actually operates a space in — a
// broad gazetteer would fire on artist biographies and exhibition histories.
// One list, two shapes: anchored for whole title segments, unanchored for place
// text found next to a link. The trailing (?![a-z]) rather than \b keeps entries
// ending in a period (l.a., st. moritz) matchable while still rejecting
// "Londonderry" for "london".
const NON_NYC_CITIES = 'london|paris|hong kong|seoul|tokyo|los angeles|l\\.a\\.|geneva|zurich|zürich|basel|berlin|brussels|milan|rome|madrid|vienna|athens|amsterdam|copenhagen|stockholm|lisbon|dublin|glasgow|munich|monaco|gstaad|st\\. moritz|shanghai|beijing|guangzhou|taipei|singapore|dubai|tokyo|osaka|mexico city|s(a|ã)o paulo|buenos aires|toronto|montreal|vancouver|chicago|san francisco|miami|palm beach|houston|dallas|boston|philadelphia|seattle|denver|detroit|atlanta|aspen|marfa|bentonville|west hollywood|beverly hills|somerset|menorca|ibiza|east hampton|bridgehampton|southampton|water mill|sag harbor|montauk|amagansett|hudson|kinderhook|beacon|catskill|rockport|princeton|greenwich|new canaan|ridgefield|venice|salzburg|oslo'

const KNOWN_NON_NYC = new RegExp(`^(${NON_NYC_CITIES})$`, 'i')

const NON_NYC_CITY_IN_TEXT = new RegExp(`\\b(${NON_NYC_CITIES})(?![a-z])`, 'i')

/** Returns the non-NYC city named in a Tier 1 location_hint, or null.
 *  Deliberately one-directional: it can say "this is elsewhere", never "this is
 *  NYC". A hint that also mentions a NYC place, or that is long enough to be prose
 *  rather than a place label, returns null so the authoritative detail-stage check
 *  decides instead. */
export function hintNamesNonNycCity(
  hint: string | null | undefined,
  showTitle?: string | null
): string | null {
  if (!hint) return null
  const h = hint.trim()
  if (!h || h.length > 120) return null
  if (NYC_PLACE.test(h)) return null
  const m = h.match(NON_NYC_CITY_IN_TEXT)
  if (!m) return null
  // A place word that is really part of the show's name is not a location. The
  // prompt already asks for null in that case ("London Calling" → null), but this
  // discard is unrecoverable — the link never reaches the detail-stage check — so
  // the guard is enforced here rather than left to the model's compliance.
  if (showTitle && showTitle.toLowerCase().includes(m[1].toLowerCase())) return null
  return m[1]
}

// Pulls the <title>, which is where multi-city galleries most reliably state
// the branch. Split on the separators sites actually use between title parts.
function titleLocationSignal(html: string): LocationCheck | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return null
  const title = m[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  if (!title) return null

  const segments = title.split(/\s*[|·•–—]\s*/).map((s) => s.trim()).filter(Boolean)
  for (const seg of segments) {
    if (KNOWN_NON_NYC.test(seg)) {
      return { verdict: 'non_nyc', city: seg, evidence: title.slice(0, 160), source: 'title', galleryMultiCity: true }
    }
  }
  // Deliberately no NYC short-circuit here. Plenty of galleries use one site-wide
  // title on every page — Salon 94's every page is titled "Art Gallery &
  // Exhibitions in New York City", including its Paris shows. Reading that as
  // proof a given show is in New York is precisely the false confirmation this
  // whole check exists to prevent, so a NYC-looking title earns nothing and the
  // page itself still gets read.
  return null
}

function pageTextForLocation(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function verifyExhibitionLocation(
  html: string,
  showTitle: string,
  venueName: string,
  venueAddress: string | null
): Promise<LocationCheck> {
  // Free, deterministic, and catches the whole multi-branch class before we
  // spend a token. Only a positive signal short-circuits — a title with no
  // city tells us nothing and falls through to the model.
  const fromTitle = titleLocationSignal(html)
  if (fromTitle) return fromTitle

  const pageTitle = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    .replace(/\s+/g, ' ').trim().slice(0, 200)
  const body = pageTextForLocation(html).slice(0, 7000)

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `Decide where this exhibition PHYSICALLY TAKES PLACE.

Gallery on file: ${venueName}${venueAddress ? ` (${venueAddress})` : ''}
Exhibition: ${showTitle}
Page title: ${pageTitle}

Rules:
- The gallery's own address is NOT evidence. Galleries list shows held at other branches, at seasonal or pop-up spaces, at off-site projects, and shows their artists are in at other institutions.
- Ignore cities that appear in artist biographies, birthplaces, collection histories, past exhibitions, or gallery footers listing every branch.
- Evidence counts only if it describes THIS exhibition's venue: "first exhibition in X", "at our X space", "at its X location", "presented at <address>", or a postal address for the show.
- If the page gives no evidence about this show's own location, answer "unknown". Do not infer from the gallery's address.

Also say whether this GALLERY operates spaces in more than one city (look for a footer or contact block listing several addresses, or a location switcher).

Return ONLY JSON, no markdown:
{"city":"<city or unknown>","evidence":"<=15 words quoted from the page, or empty>","gallery_multi_city":true|false}

Page text:
${body}`,
        },
      ],
    })

    const text = response.content.find((b) => b.type === 'text')?.text ?? ''
    const parsed = extractJsonObject<{ city?: string; evidence?: string; gallery_multi_city?: boolean }>(text)
    const city = (parsed?.city ?? '').trim()
    const galleryMultiCity = parsed?.gallery_multi_city === true

    if (!city || /^unknown$/i.test(city)) {
      return {
        verdict: 'unknown', city: null,
        evidence: parsed?.evidence?.slice(0, 160) ?? null,
        source: 'model', galleryMultiCity,
      }
    }
    return {
      verdict: NYC_PLACE.test(city) ? 'nyc' : 'non_nyc',
      city,
      evidence: parsed?.evidence?.slice(0, 160) ?? null,
      source: 'model',
      galleryMultiCity,
    }
  } catch (err) {
    // Deliberately fails to 'unknown', not 'nyc'. An unverified show goes to the
    // pending queue for review; it must never auto-publish on the strength of an
    // API error. Wrong-city shows on the live site are the failure being fixed.
    console.error(`verifyExhibitionLocation failed for "${showTitle}":`, err)
    // Multi-city assumed on error so the record is held rather than published.
    return { verdict: 'unknown', city: null, evidence: null, source: 'error', galleryMultiCity: true }
  }
}
