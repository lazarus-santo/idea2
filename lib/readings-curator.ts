import Anthropic from '@anthropic-ai/sdk'
import Exa from 'exa-js'
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
    items.push({
      title,
      link,
      author:      extractCdata(chunk, 'dc:creator') ?? extractCdata(chunk, 'author'),
      pubDate:     extractCdata(chunk, 'pubDate'),
      description: extractCdata(chunk, 'description'),
      enclosure:   chunk.match(/<enclosure[^>]+url=["']([^"']+)["']/i)?.[1] ?? null,
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

// ─── Tag a reading against venues and artists (zero API cost) ──────────────

export async function tagReading(
  readingId: string,
  headline: string,
  summary: string | null
): Promise<number> {
  const db = getSupabaseAdmin()
  const text = [headline, summary].filter(Boolean).join(' ').toLowerCase()
  const today = new Date().toISOString().split('T')[0]

  const [{ data: institutions }, { data: artists }] = await Promise.all([
    db.from('institutions').select('id, name'),
    db.from('artists').select('id, name'),
  ])

  const tags: Array<{ reading_id: string; institution_id?: string; artist_id?: string; exhibition_id?: string }> = []
  const matchedArtistIds: string[] = []

  for (const v of institutions ?? []) {
    if (v.name.length >= 4 && text.includes(v.name.toLowerCase())) {
      tags.push({ reading_id: readingId, institution_id: v.id })
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

  // For each matched artist, find their currently running exhibition.
  // Batch-fetch all links then filter client-side to avoid complex join syntax.
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
        artist_id: artistId,
        ...(exhibitionId ? { exhibition_id: exhibitionId } : {}),
      })
    }
  }

  if (tags.length === 0) return 0

  const { error } = await db.from('readings_tags').insert(tags)
  if (error) {
    console.error(`readings_tags insert failed for reading ${readingId}:`, error.message)
    return 0
  }

  return tags.length
}

// ─── Claude relevance batch check ────────────────────────────────────────────

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

// ─── Main Agent 3 pipeline ────────────────────────────────────────────────────

export interface CurationResult {
  written: number
  tagged: number
  pruned: number
  topStories: number
}

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

export async function curateReadings(): Promise<CurationResult> {
  const db = getSupabaseAdmin()

  // Approved publications that have an RSS URL
  const { data: publications } = await db
    .from('publications')
    .select('id, name, rss_url')
    .eq('status', 'approved')
    .not('rss_url', 'is', null)

  if (!publications || publications.length === 0) {
    console.log('Agent 3: no approved publications with RSS URLs')
    return { written: 0, tagged: 0, pruned: 0, topStories: 0 }
  }

  // Existing URLs — deduplicate at the DB level
  const { data: existingRows } = await db.from('readings').select('article_url')
  const existingUrls = new Set((existingRows ?? []).map((r) => r.article_url as string))

  // Collect keyword-filtered candidates across all feeds
  const candidates: Array<{ pubId: string; item: RssItem }> = []

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
        candidates.push({ pubId: pub.id as string, item })
      }
    } catch (err) {
      console.error(`RSS error for ${pub.name}:`, err)
    }
  }

  console.log(`Agent 3: ${candidates.length} keyword-filtered candidate(s) across ${publications.length} feed(s)`)

  if (candidates.length === 0) {
    const pruned = await pruneOldReadings()
    const topStories = await detectTopStories()
    return { written: 0, tagged: 0, pruned, topStories }
  }

  // Claude relevance check — batched single call
  const relevantIndices = await checkRelevance(
    candidates.map((c) => ({ title: c.item.title, description: c.item.description }))
  )
  const approved = candidates.filter((_, i) => relevantIndices.has(i))

  console.log(`Agent 3: ${approved.length} article(s) passed relevance check`)

  let written = 0
  let tagged = 0

  for (const { pubId, item } of approved) {
    const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : null
    const plainSummary = item.description ? stripHtml(item.description).slice(0, 500) : null

    const { data: inserted, error } = await db
      .from('readings')
      .insert({
        publication_id: pubId,
        author: item.author,
        headline: item.title,
        article_url: item.link,
        rss_summary: plainSummary,
        thumbnail_url: item.enclosure,
        published_at: publishedAt,
      })
      .select('id')
      .single()

    if (error) {
      // Unique constraint violations (duplicate URLs) are expected and non-fatal
      if (!error.message.includes('duplicate') && !error.message.includes('unique')) {
        console.error(`Failed to insert "${item.title}":`, error.message)
      }
      continue
    }

    written++
    existingUrls.add(item.link)

    const tagCount = await tagReading(inserted.id, item.title, plainSummary)
    if (tagCount > 0) tagged++
  }

  const pruned = await pruneOldReadings()
  const topStories = await detectTopStories()
  console.log(`Agent 3 done — written: ${written}, tagged: ${tagged}, pruned: ${pruned}, topStories: ${topStories}`)
  return { written, tagged, pruned, topStories }
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
