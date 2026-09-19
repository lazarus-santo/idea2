import Anthropic from '@anthropic-ai/sdk'
import Exa from 'exa-js'
import { getSupabaseAdmin } from './supabase'
import {
  extractJsonObject,
  publicationFromUrl,
  extractArtistSearchContext,
  searchMuseumGroupShowReview,
  type PrereadRow,
  type ShowReviewAttempt,
} from './claude'
import { MUSEUM_TARGET_DOMAINS, publicationImportanceRank } from './coverage-ranking'
import { loggedExaSearch } from './exa-log'
import type { CoverageItem, CoverageType } from './types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
const exa = new Exa(process.env.EXA_API_KEY!)

// MUSEUM_TARGET_DOMAINS and publicationImportanceRank live in lib/coverage-ranking.ts,
// shared with the public page so display order follows the same ranking.

// Museum solo searches filter to all of MUSEUM_TARGET_DOMAINS, nytimes.com included.
// It was once stripped on the belief that Exa 403s a filter naming it; that was never
// true on retest (gallery, 2026-09-18: 15+ filtered searches, 0 errors, NYT results
// returned; museum solo retested the same day).
//
// Fairs still use the old list without nytimes.com — same false premise, but fairs
// weren't part of this fix. Left for a separate decision.
const FAIR_QUERYABLE_DOMAINS = MUSEUM_TARGET_DOMAINS.filter((d) => d !== 'nytimes.com')

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

// functionName identifies the actual caller (generateSoloContemporary,
// generateSoloHistorical, generateFairCoverage) rather than always logging
// 'museumSearch' — this is the one function that issues the real Exa call for museum
// solo and fair coverage, but which classification tier or fair
// path triggered it is the useful signal for exa_search_log, same as gallery's
// distinct S1-S5/searchShowReview/searchArtistProfile labels.
async function museumSearch(
  query: string,
  numResults: number,
  exhibitionId: string | null,
  functionName: string,
  includeDomains: string[] = MUSEUM_TARGET_DOMAINS
): Promise<MuseumSearchResult[]> {
  const res = await loggedExaSearch(exa, query, {
    type: 'auto',
    numResults,
    includeDomains,
    contents: { highlights: true },
  }, { exhibitionId, functionName })
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

// Shared by every writer of museum/fair coverage (Agent 1's inline museum
// trigger, and both fair admin routes) so the three call sites can't drift
// apart on field mapping the way a copy-pasted object literal in each would
// risk. CoverageItem has no summary/highlight text of its own — summary stays
// null rather than folding author into it, now that author has its own column
// (migration_v35).
export function coverageItemToPrereadRow(exhibitionId: string, item: CoverageItem) {
  return {
    exhibition_id: exhibitionId,
    article_title: item.title,
    publication: item.publication,
    article_url: item.url,
    thumbnail_url: item.thumbnail_url,
    summary: null,
    artist_name: item.artist_name,
    item_coverage_type: item.coverage_type,
    author: item.author,
    published_date: item.published_date,
  }
}

// ─── Classification ───────────────────────────────────────────────────────────
// Two kinds of museum show, by artist count alone:
//   1 artist      → 'solo'        (then contemporary vs historical, below)
//   0 or 2+       → 'group_show'  (one show-level review search, 14-day gate)
// Replaces the old Type A/B/C-Small/C-Large/D tiers entirely.

export type MuseumShowType = 'solo' | 'group_show'

export function classifyMuseumShow(artistNames: string[]): MuseumShowType {
  return artistNames.length === 1 ? 'solo' : 'group_show'
}

// ─── Solo: contemporary or historical ────────────────────────────────────────
// Boundary: died before 1990 → historical; died 1990 or later, or still living →
// contemporary. Three tiers, each tried only when the one before fails or is unsure:
//   Tier 1  real Exa searches for the artist's birth/death, read by Haiku, which must
//           quote its evidence from the pages (the quote is checked mechanically)
//   Tier 2  classifyArtistsHistorical — Haiku from its own knowledge
//   Tier 3  Sonnet with the show's press release, forced to pick one of the two —
//           "uncertain" is not an allowed answer at this tier
// Only an Anthropic outage at Tier 3 (twice) makes this throw; Agent 2 then records
// the show as 'error' and a later run tries again, instead of guessing.

export type ArtistEra = 'contemporary' | 'historical'
export type EraTier = 'tier1_search' | 'tier2_haiku' | 'tier3_press_release'

export interface EraDecision {
  era: ArtistEra
  tier: EraTier
  /** Plain-language reason, for logs. */
  evidence: string
}

export const ERA_BOUNDARY_YEAR = 1990

export function eraFromDeathYear(deathYear: number | null): ArtistEra {
  return deathYear !== null && deathYear < ERA_BOUNDARY_YEAR ? 'historical' : 'contemporary'
}

interface EraSource { url: string; title: string; text: string }

function normalizeLoose(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function namesArtist(text: string, artist: string): boolean {
  const t = ` ${normalizeLoose(text)} `
  const parts = normalizeLoose(artist).split(' ').filter((p) => p.length > 2)
  return parts.length > 0 && parts.every((p) => t.includes(` ${p} `))
}

/**
 * Tier 1's mechanical guard on Haiku's reading: the quoted evidence must really be in
 * one of the pages, and a death year it reports must be in that quote. Returns null
 * when Haiku's answer can't be trusted.
 */
export function checkEraEvidence(
  answer: { status?: string; death_year?: number | null; evidence?: string } | null,
  sources: EraSource[]
): { status: 'deceased' | 'living'; deathYear: number | null; evidence: string } | null {
  if (!answer || (answer.status !== 'deceased' && answer.status !== 'living')) return null
  const quote = normalizeLoose(answer.evidence ?? '')
  if (quote.length < 8) return null
  if (!sources.some((s) => normalizeLoose(`${s.title} ${s.text}`).includes(quote))) return null
  if (answer.status === 'deceased') {
    const year = typeof answer.death_year === 'number' ? answer.death_year : null
    if (year === null || year < 1000 || year > new Date().getUTCFullYear()) return null
    if (!quote.includes(String(year))) return null
    return { status: 'deceased', deathYear: year, evidence: answer.evidence! }
  }
  return { status: 'living', deathYear: null, evidence: answer.evidence! }
}

const ERA_SOURCE_CHARS = 1500

/** Tier 1. null = failed or unclear (search error, nothing about this artist, or no checked evidence). */
export async function eraFromSearch(
  artistName: string,
  disambiguator: string | null,
  exhibitionId: string | null,
  exaClient: Exa = exa
): Promise<EraDecision | null> {
  const who = disambiguator ? `${artistName} ${disambiguator}` : artistName
  const opts = { type: 'auto' as const, numResults: 5, contents: { text: { maxCharacters: ERA_SOURCE_CHARS } } }
  const [bio, death] = await Promise.all([
    loggedExaSearch(exaClient, `${who} artist biography born`, opts, { exhibitionId, functionName: 'museumEraTier1' }),
    loggedExaSearch(exaClient, `${who} artist died death obituary`, opts, { exhibitionId, functionName: 'museumEraTier1' }),
  ])
  if (bio.error && death.error) {
    console.warn(`Museum era tier 1 [${artistName}]: both searches failed (${bio.error})`)
    return null
  }

  const seen = new Set<string>()
  const sources: EraSource[] = []
  for (const r of [...bio.results, ...death.results] as { url: string; title?: string | null; text?: string }[]) {
    if (seen.has(r.url)) continue
    seen.add(r.url)
    const text = (r.text ?? '').slice(0, ERA_SOURCE_CHARS)
    if (!namesArtist(`${r.title ?? ''} ${text}`, artistName)) continue
    sources.push({ url: r.url, title: r.title ?? '', text })
  }
  if (sources.length === 0) {
    console.log(`Museum era tier 1 [${artistName}]: no result names the artist`)
    return null
  }

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Below are web pages found when searching for the artist "${artistName}"${disambiguator ? ` (described as ${disambiguator})` : ''}.

Using ONLY these pages — not your own knowledge — decide whether this artist has died, and if so in what year. Some pages may be about a different person with the same name; ignore those.

- "deceased": a page states this artist's death or death year
- "living": a page clearly describes this artist as alive (e.g. "lives and works in", a recent interview, a birth year with no death year in a biographical line such as "b. 1978")
- "unknown": the pages don't settle it

"evidence" must be a short exact quote copied character-for-character from one of the pages, containing the death year when status is "deceased".

Pages:
${JSON.stringify(sources.map((s) => ({ url: s.url, title: s.title, text: s.text })))}

Return ONLY JSON: {"status": "deceased" | "living" | "unknown", "death_year": number | null, "evidence": "..."}`,
    }],
  }).catch(() => null)
  if (!response) {
    console.warn(`Museum era tier 1 [${artistName}]: reading call failed`)
    return null
  }
  const parsed = extractJsonObject<{ status?: string; death_year?: number | null; evidence?: string }>(
    response.content.find((b) => b.type === 'text')?.text ?? ''
  )
  const checked = checkEraEvidence(parsed, sources)
  if (!checked) {
    console.log(`Museum era tier 1 [${artistName}]: unclear (${parsed?.status ?? 'no answer'}${parsed?.evidence ? `, evidence "${parsed.evidence}" not confirmed` : ''})`)
    return null
  }
  const era = checked.status === 'living' ? 'contemporary' : eraFromDeathYear(checked.deathYear)
  return { era, tier: 'tier1_search', evidence: `${checked.status}${checked.deathYear ? ` ${checked.deathYear}` : ''}: "${checked.evidence}"` }
}

// ─── Tier 2: Haiku from its own knowledge ────────────────────────────────────
// "Did [artist] die before 1990?" — batched. The question used to say "deceased by
// 1990 or earlier", which put an artist who died in 1990 on the wrong side of the line.
export async function classifyArtistsHistorical(artistNames: string[]): Promise<Map<string, 'yes' | 'no' | 'uncertain'>> {
  const result = new Map<string, 'yes' | 'no' | 'uncertain'>()
  if (artistNames.length === 0) return result

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `For each artist listed below, answer: did this artist die before 1990 (that is, in 1989 or earlier)? An artist who died in 1990 or later, or who is still living, is "no".

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

// ─── Tier 3: forced answer from the press release ────────────────────────────
const ERA_TOOL = {
  name: 'record_artist_era',
  description: 'Record whether the artist is contemporary or historical.',
  input_schema: {
    type: 'object' as const,
    properties: {
      era: { type: 'string', enum: ['contemporary', 'historical'] },
      reason: { type: 'string', description: 'One sentence: what in the press release (or what you know) decided it.' },
    },
    required: ['era', 'reason'],
  },
}

export async function eraFromPressRelease(
  artistName: string,
  showTitle: string,
  venueName: string,
  pressRelease: string | null
): Promise<EraDecision> {
  const releaseText = pressRelease?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const prompt = `${releaseText ? `This is the press release for the exhibition "${showTitle}" at ${venueName}:\n\n${releaseText.slice(0, 12000)}\n\n` : `The exhibition is "${showTitle}" at ${venueName}. Its press release is not available.\n\n`}Is the artist "${artistName}" contemporary or historical?

- historical: the artist died before 1990 (1989 or earlier)
- contemporary: the artist died in 1990 or later, or is still living

Use the press release first (life dates, "the late", "lives and works", recent work, a posthumous or retrospective framing), then your own knowledge. You must choose one of the two — there is no "uncertain" answer. If the evidence is thin, choose the more likely one.`

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      tools: [ERA_TOOL],
      tool_choice: { type: 'tool', name: ERA_TOOL.name },
      messages: [{ role: 'user', content: prompt }],
    }).catch((err) => {
      console.warn(`Museum era tier 3 [${artistName}] attempt ${attempt} failed:`, err instanceof Error ? err.message : err)
      return null
    })
    const call = response?.content.find((b) => b.type === 'tool_use')
    const input = call?.type === 'tool_use' ? call.input as { era?: string; reason?: string } : null
    if (input?.era === 'contemporary' || input?.era === 'historical') {
      return { era: input.era, tier: 'tier3_press_release', evidence: input.reason ?? '' }
    }
  }
  throw new Error(`Could not classify "${artistName}" as contemporary or historical: the tier 3 call failed twice`)
}

/** Test seams: replace a tier to construct a worst case (e.g. Exa down, Haiku unsure). */
export interface EraOverrides {
  exaClient?: Exa
  tier2?: (artistName: string) => Promise<'yes' | 'no' | 'uncertain' | undefined>
}

export async function classifyArtistEra(
  artistName: string,
  show: { showTitle: string; venueName: string; pressRelease: string | null; exhibitionId: string | null },
  overrides: EraOverrides = {}
): Promise<EraDecision> {
  // The same disambiguator gallery shows use (bio first, else the press release).
  const bios = await fetchArtistBiosForEra(artistName)
  const context = await extractArtistSearchContext(show.pressRelease, [artistName], bios)
  const disambiguator = context.get(artistName)?.trim() || null

  const tier1 = await eraFromSearch(artistName, disambiguator, show.exhibitionId, overrides.exaClient)
  if (tier1) return log(tier1)

  const tier2Answer = overrides.tier2
    ? await overrides.tier2(artistName)
    : (await classifyArtistsHistorical([artistName])).get(artistName)
  if (tier2Answer === 'yes' || tier2Answer === 'no') {
    return log({ era: tier2Answer === 'yes' ? 'historical' : 'contemporary', tier: 'tier2_haiku', evidence: `Haiku: died before ${ERA_BOUNDARY_YEAR}? ${tier2Answer}` })
  }
  console.log(`Museum era tier 2 [${artistName}]: ${tier2Answer ?? 'no answer'} — going to tier 3`)

  return log(await eraFromPressRelease(artistName, show.showTitle, show.venueName, show.pressRelease))

  function log(d: EraDecision): EraDecision {
    console.log(`Museum era [${artistName}]: ${d.era} via ${d.tier} — ${d.evidence}`)
    return d
  }
}

async function fetchArtistBiosForEra(artistName: string): Promise<Map<string, string>> {
  const { data, error } = await getSupabaseAdmin().from('artists').select('name, bio').eq('name', artistName)
  if (error) throw new Error(`Artist bio read failed: ${error.message}`)
  const bios = new Map<string, string>()
  for (const row of data ?? []) {
    const bio = (row.bio as string | null)?.trim()
    if (bio) bios.set(row.name as string, bio)
  }
  return bios
}

// ─── Solo, contemporary (was Type A) ─────────────────────────────────────────
async function generateSoloContemporary(exhibitionTitle: string, institutionName: string, artistName: string, exhibitionId: string | null): Promise<CoverageItem[]> {
  const [s1, s2, s3] = await Promise.all([
    museumSearch(`${exhibitionTitle} ${artistName} ${institutionName} review`, 3, exhibitionId, 'generateSoloContemporary'),
    museumSearch(`${artistName} interview profile studio practice`, 3, exhibitionId, 'generateSoloContemporary'),
    museumSearch(`${artistName} exhibition review -${exhibitionTitle}`, 3, exhibitionId, 'generateSoloContemporary'),
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

// ─── Solo, historical (was Type B): show coverage only ───────────────────────
async function generateSoloHistorical(exhibitionTitle: string, institutionName: string, exhibitionId: string | null): Promise<CoverageItem[]> {
  const results = await museumSearch(`${exhibitionTitle} ${institutionName}`, 5, exhibitionId, 'generateSoloHistorical')
  const seenUrls = new Set<string>()
  const items: CoverageItem[] = []
  for (const r of results.filter(isValidResult)) {
    if (seenUrls.has(r.url)) continue
    seenUrls.add(r.url)
    items.push(toCoverageItem(r, 'show_coverage', null))
    if (items.length === 2) break
  }
  return items
}

export interface MuseumCoverageInput {
  exhibitionId: string | null
  showTitle: string
  venueName: string
  institutionName: string
  venueUrl: string | null
  artists: string[]
  pressRelease: string | null
  /** Group shows: whether the 14-day show-review gate is open (isShowReviewDue). */
  showReviewDue: boolean
}

export interface MuseumCoverageResult {
  coverageType: MuseumShowType
  /** Rows ready to insert (without exhibition_id). */
  prereads: PrereadRow[]
  /** Solo only. */
  era?: EraDecision
  /** Group only: whether the show review ran this time and what it found. */
  showReview?: ShowReviewAttempt
}

export async function generateMuseumCoverage(input: MuseumCoverageInput): Promise<MuseumCoverageResult> {
  const coverageType = classifyMuseumShow(input.artists)

  if (coverageType === 'solo') {
    const artist = input.artists[0]
    const era = await classifyArtistEra(artist, {
      showTitle: input.showTitle, venueName: input.venueName, pressRelease: input.pressRelease, exhibitionId: input.exhibitionId,
    })
    const coverage = era.era === 'contemporary'
      ? await generateSoloContemporary(input.showTitle, input.venueName, artist, input.exhibitionId)
      : await generateSoloHistorical(input.showTitle, input.venueName, input.exhibitionId)
    console.log(`Museum coverage [solo/${era.era} / ${input.showTitle}]:`, coverage.map((c) => ({ title: c.title, url: c.url })))
    return { coverageType, era, prereads: coverage.map((c) => coverageItemToRow(c)) }
  }

  if (!input.showReviewDue) {
    console.log(`Museum group review skipped [${input.showTitle}]: not due yet (14 days after opening)`)
    return { coverageType, prereads: [], showReview: { ran: false, result: null } }
  }
  try {
    const review = await searchMuseumGroupShowReview({
      exhibition_id: input.exhibitionId,
      show_title: input.showTitle,
      artists: input.artists,
      press_release: input.pressRelease,
      venue_name: input.venueName,
      institution_name: input.institutionName,
      venue_url: input.venueUrl,
    })
    console.log(`Museum coverage [group_show / ${input.showTitle}] (${review.anchor}):`, review.rows.map((r) => ({ title: r.article_title, url: r.article_url, flag: r.quality_flag })))
    return { coverageType, prereads: review.rows, showReview: { ran: true, result: review.result } }
  } catch (err) {
    console.error(`Museum group review failed [${input.showTitle}]:`, err)
    return { coverageType, prereads: [], showReview: { ran: true, result: 'error' } }
  }
}

function coverageItemToRow(item: CoverageItem): PrereadRow {
  const { exhibition_id: _unused, ...row } = coverageItemToPrereadRow('', item)
  void _unused
  return row
}

// ─── Fair coverage ────────────────────────────────────────────────────────────
//
// Fairs take the coverage-only path like museums, but none of the solo/group
// machinery applies. That system keys off artists — solo vs group show,
// whether the artist is historical — and a fair has no artist association
// at all: it has exhibiting galleries, and the artists shown are a booth-level
// detail this feature deliberately does not model. So this is a flat show-level
// search, two queries, no classification call.
//
// The two queries are deliberately different in kind: "<fair> review" finds
// critical write-ups, "<fair> NYC" catches previews, roundups and market reports
// that never use the word review. Results are merged and de-duplicated by URL,
// then ranked by publication importance so the strongest outlet leads.
const FAIR_COVERAGE_CAP = 5

export async function generateFairCoverage(fairName: string, exhibitionId: string | null): Promise<CoverageItem[]> {
  const [reviews, nyc] = await Promise.all([
    museumSearch(`${fairName} review`, 5, exhibitionId, 'generateFairCoverage', FAIR_QUERYABLE_DOMAINS),
    museumSearch(`${fairName} NYC`, 5, exhibitionId, 'generateFairCoverage', FAIR_QUERYABLE_DOMAINS),
  ])

  const seenUrls = new Set<string>()
  const items: CoverageItem[] = []

  for (const r of [...reviews, ...nyc].filter(isValidResult)) {
    if (seenUrls.has(r.url)) continue
    seenUrls.add(r.url)
    items.push(toCoverageItem(r, 'show_coverage', null))
  }

  items.sort((a, b) => publicationImportanceRank(a.url) - publicationImportanceRank(b.url))
  const capped = items.slice(0, FAIR_COVERAGE_CAP)

  console.log(`Fair coverage [${fairName}]: ${capped.length} of ${items.length} found`, capped.map((c) => ({ title: c.title, url: c.url })))
  return capped
}

// ─── Cross-link Agent 2's own coverage results into exhibition_coverage ────────
// Mirrors Agent 3's existing agent3-sourced cross-linking (lib/readings-curator.ts) —
// this is the agent2 direction: when a coverage result's URL already exists as a
// curated reading, link them.
export async function crossLinkCoverageToReadings(exhibitionId: string, coverage: { url: string | null }[]): Promise<void> {
  const urls = coverage.map((c) => c.url).filter((u): u is string => !!u)
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
