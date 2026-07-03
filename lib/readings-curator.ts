import Anthropic from '@anthropic-ai/sdk'
import Exa from 'exa-js'
import he from 'he'
import { getSupabaseAdmin } from './supabase'
import { startAgentRun, finishAgentRun, failAgentRun, type AgentRunError, type AgentRunResult } from './agent-runs'
import { mentionsMajorMuseum } from './agent3-constants'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// ─── RSS parsing ──────────────────────────────────────────────────────────────

interface RssItem {
  title: string
  link: string
  author: string | null
  pubDate: string | null
  description: string | null
  enclosure: string | null
}

function extractCdata(xml: string, tag: string): string | null {
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i')
  const plainRe  = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  return (xml.match(cdataRe) ?? xml.match(plainRe))?.[1]?.trim() ?? null
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = []
  for (const [, chunk] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = extractCdata(chunk, 'title')
    const link  =
      extractCdata(chunk, 'link') ??
      chunk.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/i)?.[1]?.trim() ??
      null
    if (!title || !link) continue
    // enclosure tag or media:content tag (e.g. Ocula)
    const enclosure =
      chunk.match(/<enclosure[^>]+url=["']([^"']+)["']/i)?.[1] ??
      chunk.match(/<media:content[^>]+url=["']([^"']+)["']/i)?.[1] ??
      null
    const rawAuthor = extractCdata(chunk, 'dc:creator') ?? extractCdata(chunk, 'author')
    const rawDesc   = extractCdata(chunk, 'description')
    items.push({
      title:       he.decode(title),
      link,
      author:      rawAuthor ? he.decode(rawAuthor) : null,
      pubDate:     extractCdata(chunk, 'pubDate'),
      description: rawDesc ? he.decode(rawDesc) : null,
      enclosure:   enclosure ? enclosure.replace(/[?&]w=\d+/, '') : null,
    })
  }
  return items
}

// Atom feeds (<feed><entry>...) use different tag names than RSS 2.0
// (<rss><channel><item>...) — Dazed's feed is Atom-only, no <item> at all.
function parseAtomEntries(xml: string): RssItem[] {
  const items: RssItem[] = []
  for (const [, chunk] of xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g)) {
    const title = extractCdata(chunk, 'title')
    const link =
      chunk.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i)?.[1] ??
      chunk.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ??
      null
    if (!title || !link) continue
    const rawAuthor = extractCdata(chunk, 'name') // <author><name>...</name></author>
    const rawDesc = extractCdata(chunk, 'summary') ?? extractCdata(chunk, 'content')
    items.push({
      title:       he.decode(title),
      link,
      author:      rawAuthor ? he.decode(rawAuthor) : null,
      pubDate:     extractCdata(chunk, 'published') ?? extractCdata(chunk, 'updated'),
      description: rawDesc ? he.decode(rawDesc) : null,
      enclosure:   null,
    })
  }
  return items
}

function parseRss(xml: string): RssItem[] {
  const rssItems = parseRssItems(xml)
  return rssItems.length > 0 ? rssItems : parseAtomEntries(xml)
}

// ─── Text utilities ───────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#\d]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Keyword filter ───────────────────────────────────────────────────────────

const ART_KEYWORDS = [
  'exhibition', 'gallery', 'museum', 'artwork', 'artist', 'painting', 'sculpture',
  'art fair', 'biennial', 'installation', 'curator', 'contemporary art', 'nyc art',
  'new york art', 'chelsea', 'tribeca', 'brooklyn gallery', 'art world', 'art market',
  'art review', 'art show', 'solo show', 'group show', 'opening reception',
]

function passesKeywordFilter(title: string, description: string | null): boolean {
  const text = [title, description].filter(Boolean).join(' ').toLowerCase()
  return ART_KEYWORDS.some((kw) => text.includes(kw))
}

// ─── OG image scrape ─────────────────────────────────────────────────────────

export async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const html = await res.text()
    const match =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ??
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)
    return match?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

// ─── Coverage-eligible domains for exhibition cross-linking ──────────────────

const COVERAGE_ELIGIBLE_DOMAINS = new Set([
  'artforum.com', 'hyperallergic.com', 'nytimes.com', 'artnews.com',
  'theartnewspaper.com', 'news.artnet.com', 'newyorker.com', 'frieze.com',
  'brooklynrail.org', 'ft.com',
])

function articleDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function isCoverageEligible(url: string): boolean {
  const host = articleDomain(url)
  return [...COVERAGE_ELIGIBLE_DOMAINS].some((d) => host === d || host.endsWith(`.${d}`))
}

// ─── Tag a reading against institutions and artists (zero API cost) ───────────

export async function tagReading(
  readingId: string,
  headline: string,
  summary: string | null,
  articleUrl: string
): Promise<number> {
  const db = getSupabaseAdmin()
  const text = [headline, summary].filter(Boolean).join(' ').toLowerCase()
  const today = new Date().toISOString().split('T')[0]

  const [{ data: institutions }, { data: artists }] = await Promise.all([
    db.from('institutions').select('id, name'),
    db.from('artists').select('id, name'),
  ])

  const tags: Array<{ reading_id: string; entity_type: string; entity_id: string; exhibition_id?: string }> = []
  const matchedArtistIds: string[] = []

  for (const v of institutions ?? []) {
    if (v.name.length >= 4 && text.includes(v.name.toLowerCase())) {
      tags.push({ reading_id: readingId, entity_type: 'gallery', entity_id: v.id as string })
    }
  }

  for (const a of artists ?? []) {
    const lower = a.name.toLowerCase()
    const parts = lower.split(/\s+/)
    const lastName = parts[parts.length - 1]
    const matched =
      text.includes(lower) || (lastName.length >= 5 && text.includes(lastName))
    if (matched) matchedArtistIds.push(a.id as string)
  }

  const exhibitionCoverageLinks: string[] = []

  if (matchedArtistIds.length > 0) {
    const { data: exhibitionLinks } = await db
      .from('exhibition_artists')
      .select('artist_id, exhibition_id, exhibitions!inner(start_date, end_date, status)')
      .in('artist_id', matchedArtistIds)

    const artistExhibitionMap = new Map<string, string>()
    for (const link of exhibitionLinks ?? []) {
      const ex = link.exhibitions as unknown as { start_date: string | null; end_date: string | null; status: string } | null
      if (
        ex?.status === 'published' &&
        ex.start_date && ex.end_date &&
        ex.start_date <= today && ex.end_date >= today &&
        !artistExhibitionMap.has(link.artist_id as string)
      ) {
        artistExhibitionMap.set(link.artist_id as string, link.exhibition_id as string)
      }
    }

    for (const artistId of matchedArtistIds) {
      const exhibitionId = artistExhibitionMap.get(artistId)
      tags.push({
        reading_id: readingId,
        entity_type: 'artist',
        entity_id: artistId,
        ...(exhibitionId ? { exhibition_id: exhibitionId } : {}),
      })
      if (exhibitionId) exhibitionCoverageLinks.push(exhibitionId)
    }
  }

  if (tags.length > 0) {
    const { error } = await db.from('readings_tags').insert(tags)
    if (error) {
      console.error(`readings_tags insert failed for reading ${readingId}:`, error.message)
      return 0
    }
  }

  // Cross-link to exhibition_coverage when the article comes from a coverage-eligible publication
  if (exhibitionCoverageLinks.length > 0 && isCoverageEligible(articleUrl)) {
    const dedupedExhibitionIds = [...new Set(exhibitionCoverageLinks)]
    for (const exhibitionId of dedupedExhibitionIds) {
      await db.from('exhibition_coverage').upsert(
        { exhibition_id: exhibitionId, reading_id: readingId, source: 'agent3' },
        { onConflict: 'exhibition_id,reading_id' }
      )
    }
  }

  return tags.length
}

// ─── Stage 2: Claude relevance batch check ────────────────────────────────────

// Batched like Stage 3 classification — a single call covering all candidates
// silently lost articles on busy daily runs: capped at max_tokens:300, a
// large candidate list produces an index array that gets cut off mid-array,
// the closing-bracket regex then matches nothing, and the batch quietly
// resolves to zero relevant articles with no error surfaced anywhere.
async function checkRelevance(
  articles: Array<{ title: string; description: string | null }>,
  errors: AgentRunError[] = []
): Promise<Set<number>> {
  const relevant = new Set<number>()
  if (articles.length === 0) return relevant

  for (let i = 0; i < articles.length; i += 25) {
    const batch = articles.slice(i, i + 25)
    const list = batch
      .map((a, j) => `[${j}] ${a.title}${a.description ? ` — ${stripHtml(a.description).slice(0, 200)}` : ''}`)
      .join('\n')

    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: `You are a curator for a contemporary art discovery app. From the articles below, select the ones relevant to the visual art world: gallery shows, museum programming, artist profiles or interviews, art criticism, art market news, art fairs, or exhibition reviews — anywhere, not just NYC. Art relevance is the only bar; do not exclude an article for lacking an NYC angle.

Return ONLY a JSON array of the relevant indices. Example: [0, 2, 5]. Return [] if none qualify.

Articles:
${list}`,
          },
        ],
      })

      const text = response.content[0].type === 'text' ? response.content[0].text : ''
      const match = text.match(/\[[\d,\s]*\]/)
      if (!match) {
        console.error(`Relevance batch ${i}-${i + batch.length} returned unparseable/truncated response (stop_reason: ${response.stop_reason})`)
        errors.push({
          item: `(relevance batch of ${batch.length}, offset ${i})`,
          step: 'classification',
          message: `Response unparseable — stop_reason: ${response.stop_reason}`,
        })
        continue
      }
      for (const idx of JSON.parse(match[0]) as number[]) relevant.add(i + idx)
    } catch (err) {
      console.error('Relevance check failed:', err)
      errors.push({
        item: `(relevance batch of ${batch.length}, offset ${i})`,
        step: 'classification',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return relevant
}

// ─── Stage 3: per-article classification ─────────────────────────────────────

export type ReadingCategory =
  | 'breaking_news'
  | 'institutional_news'
  | 'art_market'
  | 'interview'
  | 'opinion'
  | 'show_review'
  | 'show_roundup'

export type RiverGroup = 'news' | 'art_market' | 'people' | 'opinion'

const CATEGORY_TO_RIVER_GROUP: Record<ReadingCategory, RiverGroup> = {
  breaking_news: 'news',
  institutional_news: 'news',
  art_market: 'art_market',
  interview: 'people',
  opinion: 'opinion',
  show_review: 'opinion',
  show_roundup: 'opinion',
}

const VALID_CATEGORIES = new Set<ReadingCategory>([
  'breaking_news', 'institutional_news', 'art_market', 'interview', 'opinion', 'show_review', 'show_roundup',
])

interface ClassificationResult {
  category: ReadingCategory
  river_group: RiverGroup
  art_relevance_score: number
  nyc_relevance_score: number
  major_artist: boolean
  significant_announcement: boolean
  top_story_candidate: boolean
}

// Top Stories candidacy is derived deterministically from category +
// major_artist + significant_announcement rather than trusted from the
// model's own top_story_candidate output — the rules are mechanical enough
// (Part 3 of the Agent 3 spec) that re-deriving them in code is more
// reliable than hoping the model applies all seven consistently.
function deriveTopStoryCandidate(
  category: ReadingCategory,
  majorArtist: boolean,
  significantAnnouncement: boolean,
  articleText: string
): boolean {
  switch (category) {
    case 'breaking_news': return true
    case 'art_market': return true
    case 'institutional_news': return significantAnnouncement
    case 'interview': return majorArtist
    case 'show_review': return majorArtist || mentionsMajorMuseum(articleText)
    case 'opinion': return false // Exa cross-source corroboration handles opinion, not this call
    case 'show_roundup': return false
  }
}

const CLASSIFICATION_SYSTEM_PROMPT = `You are classifying art world articles for an NYC-focused contemporary art platform. Classify each article and return ONLY a JSON array, no commentary.

CATEGORY DEFINITIONS:
- breaking_news: deaths of artists or art world figures, major fair openings/closings (Art Basel, Frieze, Venice Biennale etc.), auction records, geopolitical events directly impacting the art world, urgent industry-wide announcements
- institutional_news: museum/gallery staff appointments or departures, solo exhibition announcements at named institutions, building openings/closings, funding announcements, institutional partnerships
- art_market: auction results and previews, market analysis, collecting trends, price records, geopolitical impact on art market, gallery representation changes
- interview: artist interviews, studio visits, profiles, conversations with artists or curators, Q&As
- opinion: criticism, essays, commentary, op-eds, cultural analysis that argues a position
- show_review: review of a specific single exhibition, in-depth critical assessment of one show
- show_roundup: listicles, seasonal guides, 'X shows to see' articles, fair previews listing multiple shows

MAJOR ARTIST DEFINITION:
An artist is considered 'major' if they have had or currently have a solo exhibition at any of these institutions: MoMA, Whitney, Guggenheim, Met, Tate Modern, Tate Britain, Centre Pompidou, Stedelijk, Kunsthaus Zürich, Hamburger Bahnhof, Fondazione Prada, Palazzo Grassi, Serpentine, Whitechapel, Hayward Gallery, LACMA, SFMOMA, Art Institute of Chicago, Walker Art Center, ICA Boston, National Gallery of Australia, Mori Art Museum, Museum of Contemporary Art Tokyo, Fondación Jumex.

SIGNIFICANT INSTITUTIONAL ANNOUNCEMENT:
An institutional_news article is 'significant' if it covers: a staff appointment or departure (director, chief curator, curator), OR a solo exhibition or retrospective announcement at a named institution.

For each article return:
{
  "index": number,
  "category": <one of the 7 categories above>,
  "art_relevance_score": 0.0-1.0,
  "nyc_relevance_score": 0.0-1.0,
  "major_artist": true | false,
  "significant_announcement": true | false
}

major_artist is true only if the article's primary subject artist meets the major artist definition above. false for group shows, institutional pieces, market pieces.
significant_announcement is true only for institutional_news that meets the significant announcement definition above.`

async function classifyArticles(
  articles: Array<{ url: string; title: string; description: string | null }>,
  errors: AgentRunError[] = []
): Promise<Map<string, ClassificationResult>> {
  const results = new Map<string, ClassificationResult>()
  if (articles.length === 0) return results

  for (let i = 0; i < articles.length; i += 15) {
    const batch = articles.slice(i, i + 15)
    const list = batch
      .map((a, j) =>
        `[${j}] ${a.title}${a.description ? ` — ${stripHtml(a.description).slice(0, 200)}` : ''}`
      )
      .join('\n')

    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        system: CLASSIFICATION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Articles:\n${list}`,
          },
        ],
      })

      const text = response.content[0].type === 'text' ? response.content[0].text : ''
      const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/)
      if (!match) continue
      const parsed = JSON.parse(match[0]) as Array<{
        index: number
        category: string
        art_relevance_score: number
        nyc_relevance_score: number
        major_artist: boolean
        significant_announcement: boolean
      }>
      for (const item of parsed) {
        const article = batch[item.index]
        if (!article) continue
        const category = VALID_CATEGORIES.has(item.category as ReadingCategory)
          ? (item.category as ReadingCategory)
          : 'opinion'
        const majorArtist = Boolean(item.major_artist)
        const significantAnnouncement = Boolean(item.significant_announcement)
        const articleText = `${article.title} ${article.description ?? ''}`
        results.set(article.url, {
          category,
          river_group: CATEGORY_TO_RIVER_GROUP[category],
          art_relevance_score: Math.min(1, Math.max(0, item.art_relevance_score ?? 0.5)),
          nyc_relevance_score: Math.min(1, Math.max(0, item.nyc_relevance_score ?? 0.5)),
          major_artist: majorArtist,
          significant_announcement: significantAnnouncement,
          top_story_candidate: deriveTopStoryCandidate(category, majorArtist, significantAnnouncement, articleText),
        })
      }
    } catch (err) {
      // classification failures are non-fatal; articles still get written without scores
      console.error('Classification batch failed:', err)
      errors.push({
        item: `(classification batch of ${batch.length})`,
        step: 'classification',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}

// ─── Top story detection (Exa cross-source corroboration) ────────────────────

async function detectTopStories(): Promise<number> {
  const exa = new Exa(process.env.EXA_API_KEY!)
  const db = getSupabaseAdmin()

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const { data: uncheckedArticles } = await db
    .from('readings')
    .select('id, headline')
    .gte('created_at', cutoff)
    .eq('top_story', false)
    .eq('top_story_checked', false)

  if (!uncheckedArticles || uncheckedArticles.length === 0) return 0

  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  let marked = 0

  for (const article of uncheckedArticles) {
    try {
      const results = await exa.search(article.headline as string, {
        type: 'auto',
        numResults: 10,
        startPublishedDate: startDate,
      })

      const uniqueDomains = new Set(
        results.results
          .map((r) => { try { return new URL(r.url).hostname.replace('www.', '') } catch { return null } })
          .filter((h): h is string => h !== null)
      )

      const isTopStory = uniqueDomains.size >= 3
      await db
        .from('readings')
        .update({ top_story: isTopStory, top_story_checked: true })
        .eq('id', article.id)

      if (isTopStory) {
        marked++
        console.log(`Top Story (${uniqueDomains.size} sources): ${article.headline}`)
      }
    } catch (err) {
      console.error(`detectTopStories error for "${article.headline}":`, err)
    }
  }

  return marked
}

// ─── Main Agent 3 pipeline ────────────────────────────────────────────────────

export interface CurationResult {
  written: number
  tagged: number
  classified: number
  pruned: number
  topStories: number
  candidatesConsidered: number
  byCategory: Record<ReadingCategory, number>
  byRiverGroup: Record<RiverGroup, number>
  topStoryCandidates: number
  majorArtistArticles: number
  significantAnnouncements: number
  nycRoundupsExcluded: number
  errors: AgentRunError[]
}

function emptyCategoryBreakdown(): Record<ReadingCategory, number> {
  return {
    breaking_news: 0, institutional_news: 0, art_market: 0,
    interview: 0, opinion: 0, show_review: 0, show_roundup: 0,
  }
}

function emptyRiverGroupBreakdown(): Record<RiverGroup, number> {
  return { news: 0, art_market: 0, people: 0, opinion: 0 }
}

const NYC_KEYWORDS = ['new york', 'nyc', 'manhattan', 'brooklyn']

// The only hard geographic filter in the pipeline (Part 6): a show_roundup
// with no NYC angle at all ("10 shows to see in London") has zero value for
// this audience. Every other category is admitted purely on art relevance.
function isNycIrrelevantRoundup(
  category: ReadingCategory,
  nycRelevanceScore: number,
  articleText: string,
  institutionNames: string[]
): boolean {
  if (category !== 'show_roundup' || nycRelevanceScore >= 0.3) return false
  const lower = articleText.toLowerCase()
  if (NYC_KEYWORDS.some((k) => lower.includes(k))) return false
  if (institutionNames.some((n) => n.length >= 4 && lower.includes(n.toLowerCase()))) return false
  return true
}

export async function curateReadings(
  tierFilter: 't1' | 'non-t1' = 'non-t1',
  errors: AgentRunError[] = []
): Promise<CurationResult> {
  const db = getSupabaseAdmin()

  let query = db
    .from('publications')
    .select('id, name, rss_url, tier')
    .eq('status', 'approved')
    .eq('active', true)
    .not('rss_url', 'is', null)

  if (tierFilter === 't1') {
    query = query.eq('scrape_frequency', 'hourly')
  } else {
    query = query.neq('scrape_frequency', 'hourly')
  }

  const { data: publications } = await query

  if (!publications || publications.length === 0) {
    console.log(`Agent 3 [${tierFilter}]: no active publications with RSS URLs`)
    return {
      written: 0, tagged: 0, classified: 0, pruned: 0, topStories: 0, candidatesConsidered: 0,
      byCategory: emptyCategoryBreakdown(), byRiverGroup: emptyRiverGroupBreakdown(),
      topStoryCandidates: 0, majorArtistArticles: 0, significantAnnouncements: 0, nycRoundupsExcluded: 0,
      errors,
    }
  }

  const { data: existingRows } = await db.from('readings').select('article_url')
  const existingUrls = new Set((existingRows ?? []).map((r) => r.article_url as string))

  const candidates: Array<{ pubId: string; pubTier: string; item: RssItem }> = []

  for (const pub of publications) {
    try {
      const res = await fetch(pub.rss_url as string, {
        headers: { 'User-Agent': 'Idea2-Art-Curator/1.0' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        console.warn(`RSS fetch failed for ${pub.name}: HTTP ${res.status}`)
        errors.push({ item: pub.name as string, step: 'fetch', message: `RSS fetch failed: HTTP ${res.status}` })
        continue
      }
      const xml = await res.text()
      const items = parseRss(xml)

      for (const item of items) {
        if (existingUrls.has(item.link)) continue
        if (!passesKeywordFilter(item.title, item.description)) continue
        candidates.push({ pubId: pub.id as string, pubTier: (pub.tier as string) ?? 'unknown', item })
      }
    } catch (err) {
      console.error(`RSS error for ${pub.name}:`, err)
      errors.push({
        item: pub.name as string,
        step: 'fetch',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  console.log(`Agent 3 [${tierFilter}]: ${candidates.length} keyword-filtered candidate(s) across ${publications.length} feed(s)`)

  if (candidates.length === 0) {
    const pruned = await pruneOldReadings()
    const topStories = await detectTopStories()
    return {
      written: 0, tagged: 0, classified: 0, pruned, topStories, candidatesConsidered: 0,
      byCategory: emptyCategoryBreakdown(), byRiverGroup: emptyRiverGroupBreakdown(),
      topStoryCandidates: 0, majorArtistArticles: 0, significantAnnouncements: 0, nycRoundupsExcluded: 0,
      errors,
    }
  }

  // Stage 2 — relevance check
  const relevantIndices = await checkRelevance(
    candidates.map((c) => ({ title: c.item.title, description: c.item.description })),
    errors
  )
  const approved = candidates.filter((_, i) => relevantIndices.has(i))
  console.log(`Agent 3 [${tierFilter}]: ${approved.length} article(s) passed relevance check`)

  // Stage 3 — classification
  const classifications = await classifyArticles(
    approved.map((c) => ({ url: c.item.link, title: c.item.title, description: c.item.description })),
    errors
  )
  console.log(`Agent 3 [${tierFilter}]: ${classifications.size} article(s) classified`)

  const { data: institutionRows } = await db.from('institutions').select('name')
  const institutionNames = (institutionRows ?? []).map((r) => r.name as string)

  let written = 0
  let tagged = 0
  let classified = 0
  const byCategory = emptyCategoryBreakdown()
  const byRiverGroup = emptyRiverGroupBreakdown()
  let topStoryCandidates = 0
  let majorArtistArticles = 0
  let significantAnnouncements = 0
  let nycRoundupsExcluded = 0

  for (const { pubId, pubTier, item } of approved) {
    const cls = classifications.get(item.link)
    const plainSummary = item.description ? stripHtml(item.description).slice(0, 500) : null
    const articleText = `${item.title} ${plainSummary ?? ''}`

    // Part 6: the one hard geographic filter in the system — a show_roundup
    // with zero NYC angle never touches the readings table.
    if (cls && isNycIrrelevantRoundup(cls.category, cls.nyc_relevance_score, articleText, institutionNames)) {
      nycRoundupsExcluded++
      continue
    }

    const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : null
    const ogImage = await fetchOgImage(item.link)
    const rawEnclosure = item.enclosure ? item.enclosure.replace(/[?&]w=\d+/, '') : null
    const thumbnailUrl = ogImage ?? rawEnclosure

    // Fast-path: any candidate meeting the deterministic Top Stories rules
    // goes live immediately, without waiting on Exa cross-source corroboration.
    const isTopStoryFastPath = cls?.top_story_candidate === true

    const { data: inserted, error } = await db
      .from('readings')
      .insert({
        publication_id:            pubId,
        author:                    item.author,
        headline:                  item.title,
        article_url:               item.link,
        rss_summary:               plainSummary,
        thumbnail_url:             thumbnailUrl,
        published_at:              publishedAt,
        category:                  cls?.category ?? null,
        river_group:               cls?.river_group ?? null,
        art_relevance_score:       cls?.art_relevance_score ?? null,
        nyc_relevance_score:       cls?.nyc_relevance_score ?? null,
        major_artist:              cls?.major_artist ?? false,
        significant_announcement:  cls?.significant_announcement ?? false,
        top_story_candidate:       cls?.top_story_candidate ?? false,
        tier:                      pubTier,
        // Fast-pathed top stories skip the Exa corroboration wait entirely
        ...(isTopStoryFastPath ? { top_story: true } : {}),
      })
      .select('id')
      .single()

    if (error) {
      if (!error.message.includes('duplicate') && !error.message.includes('unique')) {
        console.error(`Failed to insert "${item.title}":`, error.message)
        errors.push({ item: item.title, step: 'upsert', message: error.message })
      }
      continue
    }

    written++
    if (cls) {
      classified++
      byCategory[cls.category]++
      byRiverGroup[cls.river_group]++
      if (cls.top_story_candidate) topStoryCandidates++
      if (cls.major_artist) majorArtistArticles++
      if (cls.significant_announcement) significantAnnouncements++
    }
    existingUrls.add(item.link)

    if (isTopStoryFastPath) {
      console.log(`Top Story (candidate fast-path): ${item.title}`)
    }

    const tagCount = await tagReading(inserted.id, item.title, plainSummary, item.link)
    if (tagCount > 0) tagged++
  }

  const pruned = await pruneOldReadings()
  const topStories = await detectTopStories()
  console.log(`Agent 3 [${tierFilter}] done — written: ${written}, classified: ${classified}, tagged: ${tagged}, pruned: ${pruned}, topStories: ${topStories}, nycRoundupsExcluded: ${nycRoundupsExcluded}`)
  return {
    written, tagged, classified, pruned, topStories, candidatesConsidered: candidates.length,
    byCategory, byRiverGroup, topStoryCandidates, majorArtistArticles, significantAnnouncements, nycRoundupsExcluded,
    errors,
  }
}

// ─── Agent 3 run wrapper ────────────────────────────────────────────────────
// "Items" here are keyword-filtered RSS candidates considered this run.
// itemsSucceeded is readings actually written; the gap between the two is
// mostly articles the relevance check filtered out, not failures.
export async function runAgent3(tierFilter: 't1' | 'non-t1'): Promise<AgentRunResult> {
  const agent = tierFilter === 't1' ? 'agent3_hourly' : 'agent3_daily'
  const runId = await startAgentRun(agent)
  const errors: AgentRunError[] = []

  try {
    const curation = await curateReadings(tierFilter, errors)
    const result: AgentRunResult = {
      itemsProcessed: curation.candidatesConsidered,
      itemsSucceeded: curation.written,
      itemsFailed: curation.errors.length,
      errors: curation.errors,
      summary: {
        tagged: curation.tagged,
        classified: curation.classified,
        pruned: curation.pruned,
        topStories: curation.topStories,
        by_category: curation.byCategory,
        by_river_group: curation.byRiverGroup,
        top_story_candidates: curation.topStoryCandidates,
        major_artist_articles: curation.majorArtistArticles,
        significant_announcements: curation.significantAnnouncements,
        nyc_roundups_excluded: curation.nycRoundupsExcluded,
      },
    }
    await finishAgentRun(runId, result)
    return result
  } catch (err) {
    await failAgentRun(runId, err instanceof Error ? err.message : String(err))
    throw err
  }
}

async function pruneOldReadings(): Promise<number> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 7)

  const { count, error } = await getSupabaseAdmin()
    .from('readings')
    .delete({ count: 'exact' })
    .lt('published_at', cutoff.toISOString())
    .eq('top_story', false)

  if (error) console.error('Prune failed:', error.message)
  return count ?? 0
}
