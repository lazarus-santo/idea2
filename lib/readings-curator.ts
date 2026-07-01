import Anthropic from '@anthropic-ai/sdk'
import Exa from 'exa-js'
import he from 'he'
import { getSupabaseAdmin } from './supabase'

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

function parseRss(xml: string): RssItem[] {
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

async function checkRelevance(
  articles: Array<{ title: string; description: string | null }>
): Promise<Set<number>> {
  if (articles.length === 0) return new Set()

  const list = articles
    .map((a, i) => `[${i}] ${a.title}${a.description ? ` — ${stripHtml(a.description).slice(0, 200)}` : ''}`)
    .join('\n')

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `You are a curator for an NYC contemporary art discovery app. From the articles below, select the ones relevant to the NYC art world: gallery shows, museum programming, artist profiles, art criticism, art market news, or NYC exhibition reviews.

Return ONLY a JSON array of the relevant indices. Example: [0, 2, 5]. Return [] if none qualify.

Articles:
${list}`,
      },
    ],
  })

  try {
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const match = text.match(/\[[\d,\s]*\]/)
    if (!match) return new Set()
    return new Set(JSON.parse(match[0]) as number[])
  } catch {
    return new Set()
  }
}

// ─── Stage 3: per-article classification ─────────────────────────────────────

interface ClassificationResult {
  category: 'news' | 'opinion' | 'conversation'
  art_relevance_score: number
  nyc_relevance_score: number
  top_story_candidate: boolean
}

async function classifyArticles(
  articles: Array<{ url: string; title: string; description: string | null }>
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

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: `Classify each article for an NYC contemporary art discovery app.

Categories:
- "news": breaking events, obituaries, fair coverage, institutional announcements, market reports, reopenings
- "opinion": criticism, essays, reviews, commentary, op-eds
- "conversation": interviews, profiles, studio visits, artist statements, dialogues

Scores (0.0–1.0):
- art_relevance_score: how directly this concerns visual art (1.0 = entirely about visual art, 0.5 = tangential)
- nyc_relevance_score: how relevant to the NYC art scene (1.0 = NYC-specific, 0.5 = covers artist/institution with NYC presence, 0.0 = no NYC connection)
- top_story_candidate: true only for significant breaking news, major institutional announcements, fair openings/closings, notable obituaries, or stories likely covered by multiple outlets

Return ONLY a JSON array, one object per article:
[{"index":0,"category":"news","art_relevance_score":0.9,"nyc_relevance_score":0.7,"top_story_candidate":false},...]

Articles:
${list}`,
        },
      ],
    })

    try {
      const text = response.content[0].type === 'text' ? response.content[0].text : ''
      const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/)
      if (!match) continue
      const parsed = JSON.parse(match[0]) as Array<{
        index: number
        category: 'news' | 'opinion' | 'conversation'
        art_relevance_score: number
        nyc_relevance_score: number
        top_story_candidate: boolean
      }>
      for (const item of parsed) {
        const article = batch[item.index]
        if (!article) continue
        results.set(article.url, {
          category: item.category ?? 'news',
          art_relevance_score: Math.min(1, Math.max(0, item.art_relevance_score ?? 0.5)),
          nyc_relevance_score: Math.min(1, Math.max(0, item.nyc_relevance_score ?? 0.5)),
          top_story_candidate: Boolean(item.top_story_candidate),
        })
      }
    } catch {
      // classification failures are non-fatal; articles still get written without scores
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
}

export async function curateReadings(tierFilter: 't1' | 'non-t1' = 'non-t1'): Promise<CurationResult> {
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
    return { written: 0, tagged: 0, classified: 0, pruned: 0, topStories: 0 }
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
    }
  }

  console.log(`Agent 3 [${tierFilter}]: ${candidates.length} keyword-filtered candidate(s) across ${publications.length} feed(s)`)

  if (candidates.length === 0) {
    const pruned = await pruneOldReadings()
    const topStories = await detectTopStories()
    return { written: 0, tagged: 0, classified: 0, pruned, topStories }
  }

  // Stage 2 — relevance check
  const relevantIndices = await checkRelevance(
    candidates.map((c) => ({ title: c.item.title, description: c.item.description }))
  )
  const approved = candidates.filter((_, i) => relevantIndices.has(i))
  console.log(`Agent 3 [${tierFilter}]: ${approved.length} article(s) passed relevance check`)

  // Stage 3 — classification
  const classifications = await classifyArticles(
    approved.map((c) => ({ url: c.item.link, title: c.item.title, description: c.item.description }))
  )
  console.log(`Agent 3 [${tierFilter}]: ${classifications.size} article(s) classified`)

  let written = 0
  let tagged = 0
  let classified = 0

  for (const { pubId, pubTier, item } of approved) {
    const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : null
    const plainSummary = item.description ? stripHtml(item.description).slice(0, 500) : null
    const ogImage = await fetchOgImage(item.link)
    const rawEnclosure = item.enclosure ? item.enclosure.replace(/[?&]w=\d+/, '') : null
    const thumbnailUrl = ogImage ?? rawEnclosure

    const cls = classifications.get(item.link)
    const isT1BreakingNews =
      pubTier === 't1' &&
      cls?.top_story_candidate === true &&
      (cls.art_relevance_score ?? 0) >= 0.8

    const { data: inserted, error } = await db
      .from('readings')
      .insert({
        publication_id:      pubId,
        author:              item.author,
        headline:            item.title,
        article_url:         item.link,
        rss_summary:         plainSummary,
        thumbnail_url:       thumbnailUrl,
        published_at:        publishedAt,
        category:            cls?.category ?? null,
        art_relevance_score: cls?.art_relevance_score ?? null,
        nyc_relevance_score: cls?.nyc_relevance_score ?? null,
        top_story_candidate: cls?.top_story_candidate ?? false,
        tier:                pubTier,
        // T1 breaking news gets fast-pathed into top_story without waiting for Exa
        ...(isT1BreakingNews ? { top_story: true } : {}),
      })
      .select('id')
      .single()

    if (error) {
      if (!error.message.includes('duplicate') && !error.message.includes('unique')) {
        console.error(`Failed to insert "${item.title}":`, error.message)
      }
      continue
    }

    written++
    if (cls) classified++
    existingUrls.add(item.link)

    if (isT1BreakingNews) {
      console.log(`Top Story (T1 fast-path): ${item.title}`)
    }

    const tagCount = await tagReading(inserted.id, item.title, plainSummary, item.link)
    if (tagCount > 0) tagged++
  }

  const pruned = await pruneOldReadings()
  const topStories = await detectTopStories()
  console.log(`Agent 3 [${tierFilter}] done — written: ${written}, classified: ${classified}, tagged: ${tagged}, pruned: ${pruned}, topStories: ${topStories}`)
  return { written, tagged, classified, pruned, topStories }
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
