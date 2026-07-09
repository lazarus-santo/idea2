import Anthropic from '@anthropic-ai/sdk'
import Exa from 'exa-js'
import { getSupabaseAdmin } from './supabase'
import { extractJsonObject, getResultDomain, publicationFromUrl } from './claude'
import type { CoverageItem, CoverageType } from './types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
const exa = new Exa(process.env.EXA_API_KEY!)

// Order matters — also used as the publication-importance ranking for Type C-Large
// (Artforum > Hyperallergic > NYT > ARTnews > The Art Newspaper > Artnet > New Yorker
// > Frieze > Brooklyn Rail > FT).
const MUSEUM_TARGET_DOMAINS = [
  'artforum.com', 'hyperallergic.com', 'nytimes.com', 'artnews.com',
  'theartnewspaper.com', 'news.artnet.com', 'newyorker.com', 'frieze.com',
  'brooklynrail.org', 'ft.com',
]

// nytimes.com is blocked from Exa's includeDomains on this plan — a domain-filtered
// search naming it throws a 403 for the whole request, not an empty result for that
// domain (verified directly against the live API this session). Excluded here; kept
// in MUSEUM_TARGET_DOMAINS above for publication-importance ranking and display —
// a genuine NYT piece just never gets found via any of these searches, structurally,
// same limitation as the gallery pipeline.
const EXA_QUERYABLE_MUSEUM_DOMAINS = MUSEUM_TARGET_DOMAINS.filter((d) => d !== 'nytimes.com')

function publicationImportanceRank(url: string): number {
  const host = getResultDomain(url)
  const idx = MUSEUM_TARGET_DOMAINS.findIndex((d) => host === d || host.endsWith(`.${d}`))
  return idx === -1 ? MUSEUM_TARGET_DOMAINS.length : idx
}

interface MuseumSearchResult {
  url: string
  title: string | null
  author?: string | null
  publishedDate?: string
  image?: string
}

function isValidResult(r: MuseumSearchResult): r is MuseumSearchResult & { title: string } {
  return !!r.title?.trim()
}

async function museumSearch(query: string, numResults: number): Promise<MuseumSearchResult[]> {
  const res = await exa.search(query, {
    type: 'auto',
    numResults,
    includeDomains: EXA_QUERYABLE_MUSEUM_DOMAINS,
    contents: { highlights: true },
  }).catch(() => ({ results: [] as unknown[] }))
  return res.results as unknown as MuseumSearchResult[]
}

function toCoverageItem(
  r: MuseumSearchResult & { title: string },
  coverageType: CoverageType,
  artistName: string | null
): CoverageItem {
  return {
    url: r.url,
    title: r.title,
    author: r.author ?? null,
    publication: publicationFromUrl(r.url),
    published_date: r.publishedDate ?? null,
    coverage_type: coverageType,
    artist_name: artistName,
    thumbnail_url: r.image ?? null,
  }
}

// ─── Artist historical classification ──────────────────────────────────────────
// "Was [artist] deceased by 1990 or earlier?" — batched Haiku call. Only called for
// Solo/Small Group (1-5 artists); Large Group (6+) skips this entirely.
async function classifyArtistsHistorical(artistNames: string[]): Promise<Map<string, 'yes' | 'no' | 'uncertain'>> {
  const result = new Map<string, 'yes' | 'no' | 'uncertain'>()
  if (artistNames.length === 0) return result

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `For each artist listed below, answer: was this artist deceased by 1990 or earlier?

Artists: ${JSON.stringify(artistNames)}

Return ONLY a JSON object mapping each artist name to exactly one of "yes", "no", or "uncertain":
{"${artistNames[0]}": "..."}`,
    }],
  }).catch(() => null)

  if (!response) return result
  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  const parsed = extractJsonObject<Record<string, string>>(text)
  if (!parsed) return result

  for (const name of artistNames) {
    const answer = parsed[name]
    if (answer === 'yes' || answer === 'no' || answer === 'uncertain') result.set(name, answer)
  }
  return result
}

export type MuseumShowType = 'type_a' | 'type_b' | 'type_c_small' | 'type_c_large' | 'type_d'

interface MuseumClassification {
  type: MuseumShowType
  historicalByArtist: Map<string, 'yes' | 'no' | 'uncertain'>
}

async function classifyMuseumShow(artistNames: string[]): Promise<MuseumClassification> {
  if (artistNames.length === 0) {
    return { type: 'type_d', historicalByArtist: new Map() }
  }

  if (artistNames.length >= 6) {
    return { type: 'type_c_large', historicalByArtist: new Map() }
  }

  const historicalByArtist = await classifyArtistsHistorical(artistNames)

  if (artistNames.length === 1) {
    const answer = historicalByArtist.get(artistNames[0])
    // Classification call failed to produce a usable answer — Type D per spec,
    // rather than silently defaulting to Type A.
    if (!answer) return { type: 'type_d', historicalByArtist }
    return { type: answer === 'yes' ? 'type_b' : 'type_a', historicalByArtist }
  }

  // 2-5 artists: always Small Group — the per-artist classification is computed
  // (as specified) but doesn't change routing; Type C-Small doesn't further split
  // by historical status the way Solo does.
  return { type: 'type_c_small', historicalByArtist }
}

// ─── Type A — Solo, contemporary ───────────────────────────────────────────────
async function generateTypeA(exhibitionTitle: string, institutionName: string, artistName: string): Promise<CoverageItem[]> {
  const [s1, s2, s3] = await Promise.all([
    museumSearch(`${exhibitionTitle} ${artistName} ${institutionName} review`, 3),
    museumSearch(`${artistName} interview profile studio practice`, 3),
    museumSearch(`${artistName} exhibition review -${exhibitionTitle}`, 3),
  ])

  const seenUrls = new Set<string>()
  const items: CoverageItem[] = []
  const pick = (results: MuseumSearchResult[], coverageType: CoverageType) => {
    const best = results.filter(isValidResult).find((r) => !seenUrls.has(r.url))
    if (best) {
      seenUrls.add(best.url)
      items.push(toCoverageItem(best, coverageType, artistName))
    }
  }

  pick(s1, 'show_coverage')
  pick(s2, 'artist_profile')
  pick(s3, 'past_show')

  return items.slice(0, 3)
}

// ─── Type B (show coverage only) / Type D (fallback) share this shape ─────────
async function generateSingleSearchCoverage(query: string, cap: number, coverageType: CoverageType): Promise<CoverageItem[]> {
  const results = await museumSearch(query, 5)
  const seenUrls = new Set<string>()
  const items: CoverageItem[] = []
  for (const r of results.filter(isValidResult)) {
    if (seenUrls.has(r.url)) continue
    seenUrls.add(r.url)
    items.push(toCoverageItem(r, coverageType, null))
    if (items.length === cap) break
  }
  return items
}

// ─── Type C-Small — Group, 2-5 artists ─────────────────────────────────────────
async function generateTypeCSmall(
  exhibitionTitle: string,
  institutionName: string,
  artistNames: string[]
): Promise<CoverageItem[]> {
  const showResults = await museumSearch(`${exhibitionTitle} ${institutionName} review`, 5)
  const seenUrls = new Set<string>()
  const showItems: CoverageItem[] = []

  const showBest = showResults.filter(isValidResult).find((r) => !seenUrls.has(r.url))
  if (showBest) {
    seenUrls.add(showBest.url)
    showItems.push(toCoverageItem(showBest, 'show_coverage', null))
  }

  const artistsToSearch = artistNames.slice(0, 4)
  const perArtistResults = await Promise.all(
    artistsToSearch.map((artist) => museumSearch(`${artist} interview profile`, 5))
  )

  const perArtistItems: CoverageItem[] = []
  for (let i = 0; i < artistsToSearch.length; i++) {
    const best = perArtistResults[i].filter(isValidResult).find((r) => !seenUrls.has(r.url))
    if (best) {
      seenUrls.add(best.url)
      perArtistItems.push(toCoverageItem(best, 'artist_profile', artistsToSearch[i]))
    }
  }

  let combined = [...showItems, ...perArtistItems]
  if (combined.length > 5) {
    // Unreachable under the caps above (1 show result + up to 4 per-artist results
    // ≤ 5) — kept as a defensive trim only. Drops the most-recently-added per-artist
    // result first, keeping the show-coverage result.
    const allowedPerArtist = Math.max(0, 5 - showItems.length)
    combined = [...showItems, ...perArtistItems.slice(0, allowedPerArtist)]
  }

  return combined
}

// ─── Type C-Large — Group, 6+ artists ──────────────────────────────────────────
async function generateTypeCLarge(
  exhibitionTitle: string,
  institutionName: string,
  artistNames: string[]
): Promise<CoverageItem[]> {
  const showResults = await museumSearch(`${exhibitionTitle} ${institutionName} review`, 5)
  const sortedShowResults = showResults
    .filter(isValidResult)
    .sort((a, b) => publicationImportanceRank(a.url) - publicationImportanceRank(b.url))

  const seenUrls = new Set<string>()
  const items: CoverageItem[] = []
  for (const r of sortedShowResults) {
    if (items.length >= 3) break
    if (seenUrls.has(r.url)) continue
    seenUrls.add(r.url)
    items.push(toCoverageItem(r, 'show_coverage', null))
  }

  // Per-artist fill: sequential, not parallel — stops the moment the cap is hit so
  // searches never run for every artist in a large show.
  if (items.length < 5) {
    for (const artist of artistNames) {
      if (items.length >= 5) {
        console.log(`Museum Type C-Large: cap reached, skipping remaining artists`)
        break
      }
      const results = await museumSearch(`${artist} interview profile`, 5)
      const best = results
        .filter(isValidResult)
        .sort((a, b) => publicationImportanceRank(a.url) - publicationImportanceRank(b.url))
        .find((r) => !seenUrls.has(r.url))
      if (best) {
        seenUrls.add(best.url)
        items.push(toCoverageItem(best, 'artist_profile', artist))
      }
    }
  }

  return items.slice(0, 5)
}

export interface MuseumCoverageResult {
  coverage: CoverageItem[]
  coverageType: MuseumShowType
}

export async function generateMuseumCoverage(
  exhibitionTitle: string,
  institutionName: string,
  artistNames: string[]
): Promise<MuseumCoverageResult> {
  const classification = await classifyMuseumShow(artistNames)
  let coverage: CoverageItem[]

  switch (classification.type) {
    case 'type_a':
      coverage = await generateTypeA(exhibitionTitle, institutionName, artistNames[0])
      break
    case 'type_b':
      coverage = await generateSingleSearchCoverage(`${exhibitionTitle} ${institutionName}`, 2, 'show_coverage')
      break
    case 'type_c_small':
      coverage = await generateTypeCSmall(exhibitionTitle, institutionName, artistNames)
      break
    case 'type_c_large':
      coverage = await generateTypeCLarge(exhibitionTitle, institutionName, artistNames)
      break
    case 'type_d':
      coverage = await generateSingleSearchCoverage(`${exhibitionTitle} ${institutionName}`, 2, 'general')
      break
  }

  console.log(`Museum coverage [${classification.type} / ${exhibitionTitle}]:`, coverage.map((c) => ({ title: c.title, url: c.url, artist: c.artist_name })))

  return { coverage, coverageType: classification.type }
}

// ─── Cross-link Agent 2's own coverage results into exhibition_coverage ────────
// Mirrors Agent 3's existing agent3-sourced cross-linking (lib/readings-curator.ts) —
// this is the agent2 direction: when a coverage result's URL already exists as a
// curated reading, link them.
export async function crossLinkCoverageToReadings(exhibitionId: string, coverage: CoverageItem[]): Promise<void> {
  const urls = coverage.map((c) => c.url)
  if (urls.length === 0) return

  const db = getSupabaseAdmin()
  const { data: matchedReadings } = await db.from('readings').select('id, article_url').in('article_url', urls)
  if (!matchedReadings || matchedReadings.length === 0) return

  for (const reading of matchedReadings) {
    await db.from('exhibition_coverage').upsert(
      { exhibition_id: exhibitionId, reading_id: reading.id, source: 'agent2' },
      { onConflict: 'exhibition_id,reading_id' }
    )
  }
}
