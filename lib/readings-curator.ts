import he from 'he'
import { getSupabaseAdmin } from './supabase'
import { startAgentRun, finishAgentRun, failAgentRun, type AgentRunError, type AgentRunResult } from './agent-runs'
import { assignStoryGroups, supabaseStoryStore, type GroupingSummary } from './story-groups'
import { createAnthropic, accountErrorSince, callOptions, CALL_TIMEOUT_MAX_MS, type AiAccountError } from './ai-account'

const anthropic = createAnthropic()

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

// A few feeds (Mousse Magazine) publish relative <link> values instead of
// absolute URLs — nonstandard but real. Resolve against the feed's own
// domain so article_url never ends up pointing at whatever host renders it.
function resolveUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).href
  } catch {
    return url
  }
}

function parseRssItems(xml: string, baseUrl: string): RssItem[] {
  const items: RssItem[] = []
  for (const [, chunk] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = extractCdata(chunk, 'title')
    const rawLink =
      extractCdata(chunk, 'link') ??
      chunk.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/i)?.[1]?.trim() ??
      null
    const link = rawLink ? resolveUrl(rawLink, baseUrl) : null
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
function parseAtomEntries(xml: string, baseUrl: string): RssItem[] {
  const items: RssItem[] = []
  for (const [, chunk] of xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g)) {
    const title = extractCdata(chunk, 'title')
    const rawLink =
      chunk.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i)?.[1] ??
      chunk.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ??
      null
    const link = rawLink ? resolveUrl(rawLink, baseUrl) : null
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

function parseRss(xml: string, baseUrl: string): RssItem[] {
  const rssItems = parseRssItems(xml, baseUrl)
  return rssItems.length > 0 ? rssItems : parseAtomEntries(xml, baseUrl)
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

// ─── Entity tagging (removed 2026-09-14) ─────────────────────────────────────
//
// tagReading() used to substring-match every reading's headline and summary
// against the institutions and artists tables, writing readings_tags rows and,
// for a fixed list of publications, exhibition_coverage rows with
// source='agent3'. It was removed rather than repaired. A manual audit of all
// 222 tags it had produced found 77% named the wrong artist or institution:
// "Various Artists" matched any article containing "artists", and "Jeff Power"
// matched "powerful". None of its 43 exhibition links pointed to an article
// about that exhibition. Rows written before the removal are still in the
// database; nothing in this pipeline writes to either table any more.

// ─── Stage 2: Claude relevance batch check ────────────────────────────────────

// Batched like Stage 3 classification — a single call covering all candidates
// silently lost articles on busy daily runs: capped at max_tokens:300, a
// large candidate list produces an index array that gets cut off mid-array,
// the closing-bracket regex then matches nothing, and the batch quietly
// resolves to zero relevant articles with no error surfaced anywhere.
//
// `judged` holds every index in a batch that came back parseable. An index
// that is judged but not relevant is a real "no" and is remembered in
// readings_rejected; one from a failed batch is in neither set and is simply
// tried again next run.
async function checkRelevance(
  articles: Array<{ title: string; description: string | null }>,
  errors: AgentRunError[] = [],
  stopFor: () => AiAccountError | null = () => null,
  msLeft: () => number = () => CALL_TIMEOUT_MAX_MS * 2
): Promise<{ relevant: Set<number>; judged: Set<number> }> {
  const relevant = new Set<number>()
  const judged = new Set<number>()
  if (articles.length === 0) return { relevant, judged }

  for (let i = 0; i < articles.length; i += 25) {
    const blocked = stopFor()
    if (blocked) {
      errors.push(accountStopError('relevance', articles.length - i, blocked))
      break
    }
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
      }, callOptions(msLeft()))

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
      for (let j = 0; j < batch.length; j++) judged.add(i + j)
    } catch (err) {
      console.error('Relevance check failed:', err)
      errors.push({
        item: `(relevance batch of ${batch.length}, offset ${i})`,
        step: 'classification',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { relevant, judged }
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
}

const CLASSIFICATION_SYSTEM_PROMPT = `You are classifying art world articles for an NYC-focused contemporary art platform. Classify each article and return ONLY a JSON array, no commentary.

CATEGORY DEFINITIONS — check them in this order and use the first that fits:
- art_market: sales, auctions (results, previews, records), prices, and market activity — market analysis, collecting trends, gallery representation changes. A sale, a planned sale, or a lawsuit over a sale is art_market.
- institutional_news: hires, departures, appointments, and other museum/gallery announcements — solo exhibition announcements at named institutions, building openings, funding, institutional partnerships. A resignation or departure is institutional_news even when it is sudden or controversial.
- interview: artist interviews, studio visits, profiles, conversations with artists or curators, Q&As
- show_review: review of a specific single exhibition, in-depth critical assessment of one show
- show_roundup: an article listing several exhibitions to see — 'X shows to see' lists, seasonal exhibition guides, fair previews listing multiple shows. Hiring round-ups, fellowship or award announcements, news digests and book round-ups are not show_roundup.
- opinion: criticism, essays, commentary, op-eds, cultural analysis that argues a position
- breaking_news: something sudden happened — deaths, thefts (and recoveries of stolen art), arrests, lawsuits, closures, cancellations, disasters. breaking_news is only for sudden events that don't fit another category above — except that a closure or a cancellation is breaking_news even when the museum or gallery announces it. A work being moved, removed, restored, rediscovered or put on view is not breaking news.

GOSSIP COLUMNS AND ROUND-UPS: a gossip column or a news round-up that bundles several items ("Morning Links", "... and Other Art World Matters", "... and More Industry Intel", "... and Other News") — or whose summary strings together several unrelated items ("Plus, ...", "Also: ...") is labeled by what it is mostly about, judged by the item its headline leads with. A news round-up is never show_roundup.

EXAMPLES (invented, to show the overlap rule):
- "Museum director resigns amid staff complaints" → institutional_news (a departure)
- "Government to sell a painting from its embassy collection" → art_market (a planned sale)
- "Collector sues gallery over cancelled sale" → art_market (a lawsuit over a sale)
- "Council spent £50,000 removing a street mural" → opinion or institutional_news, not breaking_news (a work being moved)
- "Lost Old Master found in museum storage" → institutional_news (a rediscovery, not a sudden event)
- "Painter dies at 88" → breaking_news
- "Paintings stolen from regional museum" → breaking_news
- "Gallery closes after 12 years" → breaking_news (a closure)
- "Morning Links: Big auction totals, a new director, and more" → art_market (its lead item)
- "10 Gallery Shows to See in New York This Month" → show_roundup
- "Five museums are hiring directors" → institutional_news, not show_roundup
- "Foundation names 20 new fellows" → institutional_news, not show_roundup
- "Eight new books on Vermeer to read before the Rijksmuseum show" → opinion, not show_roundup (books, not exhibitions)
- "Museum sets reopening date" with summary "Plus, a strike at the Louvre, a new residency, and a documentary" → institutional_news (a news digest, labeled by its lead item)

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
  errors: AgentRunError[] = [],
  stopFor: () => AiAccountError | null = () => null,
  msLeft: () => number = () => CALL_TIMEOUT_MAX_MS * 2
): Promise<Map<string, ClassificationResult>> {
  const results = new Map<string, ClassificationResult>()
  if (articles.length === 0) return results

  for (let i = 0; i < articles.length; i += 15) {
    const blocked = stopFor()
    if (blocked) {
      errors.push(accountStopError('classification', articles.length - i, blocked))
      break
    }
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
        // The same article should get the same label every run: without this,
        // two identical runs disagreed on about 1 article in 10.
        temperature: 0,
        system: CLASSIFICATION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Articles:\n${list}`,
          },
        ],
      }, callOptions(msLeft()))

      const text = response.content[0].type === 'text' ? response.content[0].text : ''
      const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/)
      if (!match) {
        errors.push({
          item: `(classification batch of ${batch.length}, offset ${i})`,
          step: 'classification',
          message: `Response unparseable — stop_reason: ${response.stop_reason}`,
        })
        continue
      }
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
        results.set(article.url, {
          category,
          river_group: CATEGORY_TO_RIVER_GROUP[category],
          art_relevance_score: Math.min(1, Math.max(0, item.art_relevance_score ?? 0.5)),
          nyc_relevance_score: Math.min(1, Math.max(0, item.nyc_relevance_score ?? 0.5)),
          major_artist: Boolean(item.major_artist),
          significant_announcement: Boolean(item.significant_announcement),
        })
      }
    } catch (err) {
      // The batch's articles are left unsorted: curateReadings does not save
      // them, and the next run tries them again.
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

// ─── Top Stories ─────────────────────────────────────────────────────────────
//
// Top Stories are no longer a flag on a reading. A Top Story is a group of 3+
// different outlets covering the same event within three days, built by
// lib/story-groups.ts after each run's inserts (see curateReadings). Category,
// tier and art_relevance_score no longer decide anything here; tier only picks
// a group's lead article.
//
// The rule this replaced — a category-based candidate AND a T1 outlet AND
// art_relevance_score >= 0.8 — flagged 204 of 309 readings, let gossip columns
// in and kept multi-outlet stories from non-T1 outlets out.

// ─── One run inside 300 seconds ──────────────────────────────────────────────
//
// Every active feed is checked in one hourly run (app/api/curate/hourly), and
// the route allows 300s. Each slow stage stops at a fixed point in the run —
// counted from the run's start, not from when the stage began — so a slow
// early stage leaves the later ones less time instead of pushing the run past
// the limit. Anything a stage does not reach is left untouched and the next
// run picks it up: articles not yet sorted are neither saved nor rejected,
// readings not yet grouped stay unchecked.
//
// A stage only stops STARTING work at its mark; what is already in flight
// finishes. The gaps between marks, and the 60s after the last one, cover
// that: one Haiku batch, one round of image fetches (5s timeout each), one
// grouping comparison.
//
// scripts/test-agent3-hourly-timing.mjs, 2026-09-22. Live, against the real
// backlog left by the three-week pause (175 new articles, 309 readings never
// grouped): feeds done by ~18s, all 175 sorted by ~72s, images by ~90s, then
// Top Stories grouped 80 readings until its mark — 240s in all. Offline, with
// every service slower than ever measured at once: 244s, sorting stopped with
// 345 articles left for later runs.
const SORTING_STOP_AT_MS = 150_000   // no new chunk of articles sorted
const SORTING_HARD_STOP_MS = 200_000 // the chunk in flight gives up by here
const IMAGES_STOP_AT_MS = 230_000    // later articles keep their RSS image, if any
const GROUPING_STOP_AT_MS = 240_000  // no new Top Stories comparison

// Articles go through relevance and classification this many at a time: one
// relevance call and at most two classification calls, ~10–25s in all.
const SORT_CHUNK = 25

// Each Haiku call gets the time left before SORTING_HARD_STOP_MS (see
// callOptions in ai-account): the chunk in flight when SORTING_STOP_AT_MS
// passes still has to end, hung or rate-limited call or not.

// Feeds and article pages are fetched this many at a time. One at a time, the
// 30 feeds took ~41s and one outlet timing out (15s) held up every feed behind
// it; six at a time, the whole pass is about as long as the slowest feed.
const FEED_CONCURRENCY = 6
const IMAGE_CONCURRENCY = 8

// Undated articles sort last: the river never shows them anyway.
function publishedMs(item: RssItem): number {
  const t = item.pubDate ? new Date(item.pubDate).getTime() : NaN
  return Number.isNaN(t) ? 0 : t
}

// Runs fn over items, `limit` at a time, returning results in input order.
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ─── Stopping on an account problem ──────────────────────────────────────────
//
// Once Anthropic or Voyage refuses for billing, a rejected key or a usage limit
// (lib/ai-account.ts), every further call this run would be refused too. The
// run stops calling and says how many articles it left; they are neither saved
// nor rejected, so the next run picks them up. The admin panel shows the
// problem until a run's AI calls succeed again (app/api/admin/ai-status).
function accountStopError(stage: string, left: number, e: AiAccountError): AgentRunError {
  return {
    item: `(${stage}: ${left} article(s) left for the next run)`,
    step: 'classification',
    message: `Stopped — ${e.provider} ${e.problem} error (HTTP ${e.status}): ${e.message}`,
  }
}

// ─── Feeds read past their first page ────────────────────────────────────────
//
// Mousse Magazine's feed is not in date order and shows 4 articles a page: on
// 2026-09-21 a 10 Sep review sat on page 2 behind three from 28 Aug, where a
// page-1-only check could miss it. Pages 2 and 3 are read on every run.
// Anything already saved or turned down is skipped as usual, and anything
// older than RETENTION_DAYS is dropped before it reaches Haiku. WordPress
// serves page n at ?paged=n.
const FEED_PAGES: Record<string, number> = {
  'www.moussemagazine.it': 3,
}

function feedPages(rssUrl: string): string[] {
  let base: URL
  try {
    base = new URL(rssUrl)
  } catch {
    return [rssUrl]
  }
  const urls = [rssUrl]
  for (let page = 2; page <= (FEED_PAGES[base.hostname] ?? 1); page++) {
    const url = new URL(base)
    url.searchParams.set('paged', String(page))
    urls.push(url.href)
  }
  return urls
}

// ─── Main Agent 3 pipeline ────────────────────────────────────────────────────

export interface CurationResult {
  written: number
  classified: number
  staleSkipped: number
  alreadySaved: number
  rejectedSkipped: number
  rejectionsRecorded: number
  candidatesConsidered: number
  byCategory: Record<ReadingCategory, number>
  byRiverGroup: Record<RiverGroup, number>
  storyGrouping: GroupingSummary | null
  majorArtistArticles: number
  significantAnnouncements: number
  nycRoundupsExcluded: number
  // Approved as art but not sorted into a category this run: not saved, tried again next run.
  awaitingClassification: number
  // Not yet checked for relevance when the run reached SORTING_STOP_AT_MS; tried again next run.
  leftForNextRun: number
  // Each stage that stopped at its mark in the run rather than finishing.
  stoppedForTime: { sorting: boolean; images: boolean }
  // The billing/key/limit error that stopped this run's AI calls, if any.
  accountError: AiAccountError | null
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

// ─── Already-seen lookups ────────────────────────────────────────────────────
//
// Agent 3 used to load every saved article_url and check feed links against
// that set. Supabase returns at most 1,000 rows per request, so past 1,000
// readings the set was silently incomplete — and readings are kept forever now.
// Instead, only this run's feed links are looked up, a slice at a time: the
// links travel in the request URL, and 50 keeps it well under length limits.
const URL_LOOKUP_CHUNK = 50

async function findKnownUrls(
  db: ReturnType<typeof getSupabaseAdmin>,
  table: 'readings' | 'readings_rejected',
  urls: string[]
): Promise<Set<string>> {
  const known = new Set<string>()
  for (let i = 0; i < urls.length; i += URL_LOOKUP_CHUNK) {
    const chunk = urls.slice(i, i + URL_LOOKUP_CHUNK)
    const { data, error } = await db.from(table).select('article_url').in('article_url', chunk)
    // A failed lookup must not read as "nothing saved": that would send every
    // article in the feeds to Haiku again. The caller decides what it costs.
    if (error) throw new Error(`${table} lookup failed: ${error.message}`)
    for (const row of data ?? []) known.add(row.article_url as string)
  }
  return known
}

interface RejectionRow {
  article_url: string
  publication_id: string
  headline: string
  reason: 'not_relevant' | 'nyc_roundup'
}

// Remember articles a check actually ruled against (migration_v69), so the next
// run skips them instead of paying Haiku to turn them down again. Failing to
// write is a run error, never a failed run: the readings are already saved.
async function recordRejections(
  db: ReturnType<typeof getSupabaseAdmin>,
  rows: RejectionRow[],
  errors: AgentRunError[]
): Promise<number> {
  if (rows.length === 0) return 0
  const { error } = await db
    .from('readings_rejected')
    .upsert(rows, { onConflict: 'article_url', ignoreDuplicates: true })
  if (error) {
    errors.push({ item: `(${rows.length} rejected article(s))`, step: 'upsert', message: error.message })
    return 0
  }
  return rows.length
}

// Every approved, active publication with a feed, every run. publications.
// scrape_frequency (migration_v13) used to split them into an hourly T1 run and
// a daily run for the rest; nothing reads it any more. tier is still loaded:
// it picks a Top Story's lead article.
export async function curateReadings(errors: AgentRunError[] = []): Promise<CurationResult> {
  const db = getSupabaseAdmin()
  const runStart = Date.now()
  const accountStop = () => accountErrorSince(runStart)

  const { data: publications } = await db
    .from('publications')
    .select('id, name, rss_url, tier')
    .eq('status', 'approved')
    .eq('active', true)
    .not('rss_url', 'is', null)

  if (!publications || publications.length === 0) {
    console.log('Agent 3: no active publications with RSS URLs')
    return {
      written: 0, classified: 0, candidatesConsidered: 0, staleSkipped: 0,
      alreadySaved: 0, rejectedSkipped: 0, rejectionsRecorded: 0, awaitingClassification: 0, accountError: null,
      leftForNextRun: 0, stoppedForTime: { sorting: false, images: false },
      byCategory: emptyCategoryBreakdown(), byRiverGroup: emptyRiverGroupBreakdown(),
      storyGrouping: null, majorArtistArticles: 0, significantAnnouncements: 0, nycRoundupsExcluded: 0,
      errors,
    }
  }

  // Every feed page, fetched FEED_CONCURRENCY at a time. Results come back in
  // publication order whatever order they finish in, so which feed "owns" an
  // article that appears in two is the same as when they were read one by one.
  const pages = publications.flatMap((pub) =>
    feedPages(pub.rss_url as string).map((url, page) => ({
      pub,
      url,
      label: page === 0 ? (pub.name as string) : `${pub.name} (page ${page + 1})`,
    }))
  )
  const fetched = await mapConcurrent(pages, FEED_CONCURRENCY, async ({ pub, url, label }) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Idea2-Art-Curator/1.0' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        console.warn(`RSS fetch failed for ${label}: HTTP ${res.status}`)
        errors.push({ item: label, step: 'fetch', message: `RSS fetch failed: HTTP ${res.status}` })
        return { pub, items: [] as RssItem[] }
      }
      return { pub, items: parseRss(await res.text(), url) }
    } catch (err) {
      console.error(`RSS error for ${label}:`, err)
      errors.push({
        item: label,
        step: 'fetch',
        message: err instanceof Error ? err.message : String(err),
      })
      return { pub, items: [] as RssItem[] }
    }
  })

  // Every keyword-matching item across all feeds, one entry per link — the same
  // article in two feeds is only considered once.
  const feedItems = new Map<string, { pubId: string; pubTier: string; item: RssItem }>()
  for (const { pub, items } of fetched) {
    for (const item of items) {
      if (feedItems.has(item.link)) continue
      if (!passesKeywordFilter(item.title, item.description)) continue
      feedItems.set(item.link, { pubId: pub.id as string, pubTier: (pub.tier as string) ?? 'unknown', item })
    }
  }

  const feedLinks = [...feedItems.keys()]
  const existingUrls = await findKnownUrls(db, 'readings', feedLinks)
  // A missing or unreadable rejection list costs money, not correctness: every
  // rejection is re-checked, as before migration_v69. So it is a run error, not
  // a failed run.
  let rejectedUrls = new Set<string>()
  try {
    rejectedUrls = await findKnownUrls(db, 'readings_rejected', feedLinks)
  } catch (err) {
    errors.push({
      item: '(rejected-articles lookup)',
      step: 'fetch',
      message: err instanceof Error ? err.message : String(err),
    })
  }

  const candidates: Array<{ pubId: string; pubTier: string; item: RssItem }> = []
  let staleSkipped = 0
  let alreadySaved = 0
  let rejectedSkipped = 0
  for (const [link, entry] of feedItems) {
    if (existingUrls.has(link)) { alreadySaved++; continue }
    if (rejectedUrls.has(link)) { rejectedSkipped++; continue }
    if (isOutsideRetention(entry.item.pubDate)) { staleSkipped++; continue }
    candidates.push(entry)
  }

  console.log(`Agent 3: ${alreadySaved} already saved, ${rejectedSkipped} already turned down`)
  console.log(`Agent 3: ${candidates.length} candidate(s) across ${publications.length} feed(s); ${staleSkipped} skipped as older than ${RETENTION_DAYS} days`)

  if (candidates.length === 0) {
    return {
      written: 0, classified: 0, candidatesConsidered: 0, staleSkipped,
      alreadySaved, rejectedSkipped, rejectionsRecorded: 0, awaitingClassification: 0, accountError: null,
      leftForNextRun: 0, stoppedForTime: { sorting: false, images: false },
      byCategory: emptyCategoryBreakdown(), byRiverGroup: emptyRiverGroupBreakdown(),
      storyGrouping: null, majorArtistArticles: 0, significantAnnouncements: 0, nycRoundupsExcluded: 0,
      errors,
    }
  }

  // Stages 2 and 3 — relevance, then classification — a chunk at a time,
  // newest articles first. Each chunk is sorted all the way through before the
  // next one starts, and no chunk starts past SORTING_STOP_AT_MS. Stopping
  // between chunks rather than between stages is what makes a big backlog
  // shrink: an article approved but never classified is neither saved nor
  // rejected, so a run that did every relevance check and then ran out of time
  // would leave the next run the same backlog, to run out of time on again.
  const byNewest = [...candidates].sort((a, b) => publishedMs(b.item) - publishedMs(a.item))
  const approved: typeof candidates = []
  const classifications = new Map<string, ClassificationResult>()
  const rejections: RejectionRow[] = []
  let leftForTime = 0
  let sortingStoppedForTime = false

  for (let i = 0; i < byNewest.length; i += SORT_CHUNK) {
    if (Date.now() - runStart >= SORTING_STOP_AT_MS) {
      leftForTime = byNewest.length - i
      sortingStoppedForTime = true
      console.log(`Agent 3: out of time — ${leftForTime} article(s) left for the next run`)
      break
    }
    const blocked = accountStop()
    if (blocked) {
      errors.push(accountStopError('relevance', byNewest.length - i, blocked))
      break
    }
    const chunk = byNewest.slice(i, i + SORT_CHUNK)
    const sortingMsLeft = () => SORTING_HARD_STOP_MS - (Date.now() - runStart)
    const { relevant, judged } = await checkRelevance(
      chunk.map((c) => ({ title: c.item.title, description: c.item.description })),
      errors,
      accountStop,
      sortingMsLeft
    )
    const chunkApproved = chunk.filter((_, j) => relevant.has(j))
    approved.push(...chunkApproved)
    for (const [j, c] of chunk.entries()) {
      if (judged.has(j) && !relevant.has(j)) {
        rejections.push({ article_url: c.item.link, publication_id: c.pubId, headline: c.item.title, reason: 'not_relevant' })
      }
    }
    const sorted = await classifyArticles(
      chunkApproved.map((c) => ({ url: c.item.link, title: c.item.title, description: c.item.description })),
      errors,
      accountStop,
      sortingMsLeft
    )
    for (const [url, cls] of sorted) classifications.set(url, cls)
  }
  console.log(`Agent 3: ${approved.length} article(s) passed relevance check, ${classifications.size} classified`)

  const { data: institutionRows } = await db.from('institutions').select('name')
  const institutionNames = (institutionRows ?? []).map((r) => r.name as string)

  let written = 0
  let classified = 0
  const byCategory = emptyCategoryBreakdown()
  const byRiverGroup = emptyRiverGroupBreakdown()
  let majorArtistArticles = 0
  let significantAnnouncements = 0
  let nycRoundupsExcluded = 0
  let awaitingClassification = 0
  const toSave: Array<{ pubId: string; pubTier: string; item: RssItem; cls: ClassificationResult; plainSummary: string | null }> = []

  for (const { pubId, pubTier, item } of approved) {
    const cls = classifications.get(item.link)
    // Never saved without a category. If sorting failed for any reason — an
    // API error, an unparseable answer, an article Haiku left out, an account
    // stop — the article is neither saved nor rejected, so the next run tries
    // it again while it is still in its feed and inside RETENTION_DAYS.
    if (!cls) {
      awaitingClassification++
      continue
    }
    const plainSummary = item.description ? stripHtml(item.description).slice(0, 500) : null
    const articleText = `${item.title} ${plainSummary ?? ''}`

    // Part 6: the one hard geographic filter in the system — a show_roundup
    // with zero NYC angle never touches the readings table.
    if (isNycIrrelevantRoundup(cls.category, cls.nyc_relevance_score, articleText, institutionNames)) {
      nycRoundupsExcluded++
      rejections.push({ article_url: item.link, publication_id: pubId, headline: item.title, reason: 'nyc_roundup' })
      continue
    }
    toSave.push({ pubId, pubTier, item, cls, plainSummary })
  }

  // Article images, IMAGE_CONCURRENCY pages at a time. Past IMAGES_STOP_AT_MS
  // the rest are not fetched; those articles are saved with their RSS image
  // (enclosure) if the feed gave one, as when a page has no og:image.
  const imagesOutOfTime = () => Date.now() - runStart >= IMAGES_STOP_AT_MS
  let imagesStoppedForTime = false
  const ogImages = await mapConcurrent(toSave, IMAGE_CONCURRENCY, async ({ item }) => {
    if (imagesOutOfTime()) {
      imagesStoppedForTime = true
      return null
    }
    return fetchOgImage(item.link)
  })

  for (const [i, { pubId, pubTier, item, cls, plainSummary }] of toSave.entries()) {
    const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : null
    const rawEnclosure = item.enclosure ? item.enclosure.replace(/[?&]w=\d+/, '') : null
    const thumbnailUrl = ogImages[i] ?? rawEnclosure

    const { error } = await db
      .from('readings')
      .insert({
        publication_id:            pubId,
        author:                    item.author,
        headline:                  item.title,
        article_url:               item.link,
        rss_summary:               plainSummary,
        thumbnail_url:             thumbnailUrl,
        published_at:              publishedAt,
        category:                  cls.category,
        river_group:               cls.river_group,
        art_relevance_score:       cls.art_relevance_score,
        nyc_relevance_score:       cls.nyc_relevance_score,
        major_artist:              cls.major_artist,
        significant_announcement:  cls.significant_announcement,
        tier:                      pubTier,
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
    classified++
    byCategory[cls.category]++
    byRiverGroup[cls.river_group]++
    if (cls.major_artist) majorArtistArticles++
    if (cls.significant_announcement) significantAnnouncements++
  }

  const rejectionsRecorded = await recordRejections(db, rejections, errors)

  // Nothing is deleted here any more. Readings are kept indefinitely: the river
  // shows the last 7 days and ignores the rest, but anything that references a
  // reading later — an editor's pick, a search, a person's log — needs the row to
  // still exist. The old prune deleted past the same 7 days and had already cost
  // one editor's pick, which quietly stopped rendering when its article went.
  //
  // Top Stories: group whatever has not been grouped yet — this run's new
  // readings, plus any a previous run left unchecked. A failure here never
  // costs the readings already written; they stay unchecked and retry.
  let storyGrouping: GroupingSummary | null = null
  try {
    storyGrouping = await assignStoryGroups(supabaseStoryStore(db), {
      deadline: runStart + GROUPING_STOP_AT_MS,
      shouldStop: () => accountStop() !== null,
    })
    for (const message of storyGrouping.errors) {
      errors.push({ item: '(story grouping)', step: 'classification', message })
    }
  } catch (err) {
    errors.push({
      item: '(story grouping)',
      step: 'classification',
      message: err instanceof Error ? err.message : String(err),
    })
  }

  console.log(`Agent 3 done — written: ${written}, classified: ${classified}, grouped: ${storyGrouping?.checked ?? 0}, nycRoundupsExcluded: ${nycRoundupsExcluded}`)
  return {
    written, classified, candidatesConsidered: candidates.length, staleSkipped,
    alreadySaved, rejectedSkipped, rejectionsRecorded, awaitingClassification, accountError: accountStop(),
    leftForNextRun: leftForTime, stoppedForTime: { sorting: sortingStoppedForTime, images: imagesStoppedForTime },
    byCategory, byRiverGroup, storyGrouping, majorArtistArticles, significantAnnouncements, nycRoundupsExcluded,
    errors,
  }
}

// ─── Agent 3 run wrapper ────────────────────────────────────────────────────
// "Items" here are keyword-filtered RSS candidates considered this run.
// itemsSucceeded is readings actually written; the gap between the two is
// mostly articles the relevance check filtered out, not failures.
//
// One run covers every feed and is recorded as agent3_hourly. agent3_daily
// is no longer written; it stays in AgentName so its past runs still load.
export async function runAgent3(): Promise<AgentRunResult> {
  const runId = await startAgentRun('agent3_hourly')
  const errors: AgentRunError[] = []

  try {
    const curation = await curateReadings(errors)
    const result: AgentRunResult = {
      itemsProcessed: curation.candidatesConsidered,
      itemsSucceeded: curation.written,
      itemsFailed: curation.errors.length,
      errors: curation.errors,
      summary: {
        classified: curation.classified,
        stale_skipped: curation.staleSkipped,
        already_saved: curation.alreadySaved,
        rejected_skipped: curation.rejectedSkipped,
        rejections_recorded: curation.rejectionsRecorded,
        by_category: curation.byCategory,
        by_river_group: curation.byRiverGroup,
        story_grouping: curation.storyGrouping && {
          checked: curation.storyGrouping.checked,
          embedded: curation.storyGrouping.embedded,
          llm_calls: curation.storyGrouping.llmCalls,
          joined_group: curation.storyGrouping.joinedGroup,
          started_group: curation.storyGrouping.startedGroup,
          leads_set: curation.storyGrouping.leadsSet,
          split_signals: curation.storyGrouping.splitSignals.length,
          stopped_for_time: curation.storyGrouping.stoppedForTime,
          stopped_for_account: curation.storyGrouping.stoppedForAccount,
        },
        major_artist_articles: curation.majorArtistArticles,
        significant_announcements: curation.significantAnnouncements,
        nyc_roundups_excluded: curation.nycRoundupsExcluded,
        awaiting_classification: curation.awaitingClassification,
        left_for_next_run: curation.leftForNextRun,
        stopped_for_time: curation.stoppedForTime,
      },
    }
    await finishAgentRun(runId, result)
    return result
  } catch (err) {
    await failAgentRun(runId, err instanceof Error ? err.message : String(err))
    throw err
  }
}

// How far back Agent 3 will look when deciding whether an article is worth
// classifying. Readings are never deleted — pruneOldReadings is gone, so nothing
// ages out of the database. This is purely a spend limit: /api/river only ever
// shows the last 7 days, so classifying an older article buys a row no one will
// see. It deliberately matches the river's own window.
const RETENTION_DAYS = 7

function retentionCutoff(): Date {
  const d = new Date()
  d.setDate(d.getDate() - RETENTION_DAYS)
  return d
}

/**
 * True when an RSS item is older than the window the river displays, so writing
 * it would buy a row that never appears on the page.
 *
 * Measured on the 2026-08-04 daily run before this existed: 111 articles were
 * classified and written, 92 of them older than the window — 83% of the
 * Anthropic spend for that run bought rows no reader would ever reach. Feeds that
 * serve long back-catalogues (The Nation's culture feed returns 50 items
 * spanning months) are the main source.
 *
 * Undated items are kept: dropping them here would lose articles that may well
 * be current, and the river simply never shows them (it filters on
 * published_at).
 */
function isOutsideRetention(pubDate: string | null): boolean {
  if (!pubDate) return false
  const t = new Date(pubDate).getTime()
  if (Number.isNaN(t)) return false // unparseable — treat as undated, keep
  return t < retentionCutoff().getTime()
}

