import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

interface SearchResult {
  id: string
  title: string
  category: 'exhibition' | 'reading'
  image_url: string | null
  url: string | null
  is_external: boolean
  subtitle: string | null
}

interface SubResult {
  id: string
  title: string
  image_url: string | null
  url: string | null
  is_external: boolean
  subtitle: string | null
}

interface EnrichedResult {
  id: string
  name: string
  category: 'artist' | 'institution'
  url: string | null
  exhibitions: SubResult[]
  readings: SubResult[]
  exhibition_count: number
  reading_count: number
}

function sortFlat(items: SearchResult[], q: string): SearchResult[] {
  const lq = q.toLowerCase()
  return [...items].sort((a, b) =>
    (a.title.toLowerCase().startsWith(lq) ? 0 : 1) -
    (b.title.toLowerCase().startsWith(lq) ? 0 : 1)
  )
}

function sortEnriched(items: EnrichedResult[], q: string): EnrichedResult[] {
  const lq = q.toLowerCase()
  return [...items].sort((a, b) =>
    (a.name.toLowerCase().startsWith(lq) ? 0 : 1) -
    (b.name.toLowerCase().startsWith(lq) ? 0 : 1)
  )
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const mode = req.nextUrl.searchParams.get('mode') ?? 'full'

  if (!q || q.length < 2) {
    return NextResponse.json({ exhibitions: [], institutions: [], readings: [], artists: [] })
  }

  const sb = getSupabaseAdmin()
  const pattern = `%${q}%`
  const perCat = mode === 'dropdown' ? 3 : 50
  const today = new Date().toISOString().split('T')[0]

  // Phase 1: parallel searches
  const [exByTitle, artistsRaw, institutionsRaw, readingsRaw] = await Promise.all([
    sb
      .from('exhibitions')
      .select('id, show_title, image_url, venues(name)')
      .eq('status', 'published')
      .ilike('show_title', pattern)
      .limit(perCat),

    sb
      .from('artists')
      .select('id, name, exhibition_artists(exhibitions(id, show_title, image_url, status, start_date, end_date, venues(name), prereads(id, article_title, article_url, publication, summary, thumbnail_url)))')
      .ilike('name', pattern)
      .limit(perCat),

    sb
      .from('institutions')
      .select('id, name, venues(exhibitions(id, show_title, image_url, status, start_date, end_date, prereads(id, article_title, article_url, publication, thumbnail_url)))')
      .ilike('name', pattern)
      .limit(perCat),

    sb
      .from('readings')
      .select('id, headline, article_url, thumbnail_url, author, publications(name)')
      .or(`headline.ilike.${pattern},rss_summary.ilike.${pattern}`)
      .limit(perCat),
  ])

  // Phase 2: readings_tags for enriched entities
  const artistIds = (artistsRaw.data ?? []).map((a: any) => a.id) // eslint-disable-line @typescript-eslint/no-explicit-any
  const galleryIds = (institutionsRaw.data ?? []).map((g: any) => g.id) // eslint-disable-line @typescript-eslint/no-explicit-any

  const [artistTagsRaw, galleryTagsRaw] = await Promise.all([
    artistIds.length > 0
      ? sb
          .from('readings_tags')
          .select('entity_id, readings(id, headline, article_url, thumbnail_url, publications(name))')
          .eq('entity_type', 'artist')
          .in('entity_id', artistIds)
      : Promise.resolve({ data: [] as any[], error: null }), // eslint-disable-line @typescript-eslint/no-explicit-any
    galleryIds.length > 0
      ? sb
          .from('readings_tags')
          .select('entity_id, readings(id, headline, article_url, thumbnail_url, publications(name))')
          .eq('entity_type', 'gallery')
          .in('entity_id', galleryIds)
      : Promise.resolve({ data: [] as any[], error: null }), // eslint-disable-line @typescript-eslint/no-explicit-any
  ])

  // Exhibition results: title matches + artist-linked matches (deduplicated)
  const seenExhibitions = new Set<string>()
  const exhibitionResults: SearchResult[] = []

  for (const e of exByTitle.data ?? []) {
    const ex = e as any // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!seenExhibitions.has(ex.id)) {
      seenExhibitions.add(ex.id)
      exhibitionResults.push({
        id: ex.id,
        title: ex.show_title,
        category: 'exhibition',
        image_url: ex.image_url ?? null,
        url: `/exhibitions/${ex.id}`,
        is_external: false,
        subtitle: ex.venues?.name ?? null,
      })
    }
  }

  for (const artist of artistsRaw.data ?? []) {
    const a = artist as any // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const ea of a.exhibition_artists ?? []) {
      const ex = ea.exhibitions
      if (!ex || ex.status !== 'published') continue
      if (!seenExhibitions.has(ex.id)) {
        seenExhibitions.add(ex.id)
        exhibitionResults.push({
          id: ex.id,
          title: ex.show_title,
          category: 'exhibition',
          image_url: ex.image_url ?? null,
          url: `/exhibitions/${ex.id}`,
          is_external: false,
          subtitle: ex.venues?.name ?? null,
        })
      }
    }
  }

  // Reading results
  const readingResults: SearchResult[] = (readingsRaw.data ?? []).map((r: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
    id: r.id,
    title: r.headline,
    category: 'reading' as const,
    image_url: r.thumbnail_url ?? null,
    url: r.article_url,
    is_external: true,
    subtitle: r.publications?.name ?? r.author ?? null,
  }))

  // Count artists per exhibition so we can exclude group-show prereads from artist results
  const allExhibitionIds = (artistsRaw.data ?? []).flatMap((a: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
    (a.exhibition_artists ?? []).map((ea: any) => ea.exhibitions?.id).filter(Boolean) // eslint-disable-line @typescript-eslint/no-explicit-any
  )
  const exhibitionArtistCount = new Map<string, number>()
  if (allExhibitionIds.length > 0) {
    const { data: eaRows } = await sb
      .from('exhibition_artists')
      .select('exhibition_id')
      .in('exhibition_id', allExhibitionIds)
    for (const row of eaRows ?? []) {
      const r = row as any // eslint-disable-line @typescript-eslint/no-explicit-any
      exhibitionArtistCount.set(r.exhibition_id, (exhibitionArtistCount.get(r.exhibition_id) ?? 0) + 1)
    }
  }

  // Group readings_tags by entity ID
  const artistReadingsMap = new Map<string, SubResult[]>()
  for (const tag of artistTagsRaw.data ?? []) {
    const t = tag as any // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!t.readings?.id || !t.entity_id) continue
    const sub: SubResult = {
      id: t.readings.id,
      title: t.readings.headline,
      image_url: t.readings.thumbnail_url ?? null,
      url: t.readings.article_url,
      is_external: true,
      subtitle: t.readings.publications?.name ?? null,
    }
    const arr = artistReadingsMap.get(t.entity_id) ?? []
    arr.push(sub)
    artistReadingsMap.set(t.entity_id, arr)
  }

  const galleryReadingsMap = new Map<string, SubResult[]>()
  for (const tag of galleryTagsRaw.data ?? []) {
    const t = tag as any // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!t.readings?.id || !t.entity_id) continue
    const sub: SubResult = {
      id: t.readings.id,
      title: t.readings.headline,
      image_url: t.readings.thumbnail_url ?? null,
      url: t.readings.article_url,
      is_external: true,
      subtitle: t.readings.publications?.name ?? null,
    }
    const arr = galleryReadingsMap.get(t.entity_id) ?? []
    arr.push(sub)
    galleryReadingsMap.set(t.entity_id, arr)
  }

  // Enriched artist results — exhibitions + prereads from each exhibition
  const artistResults: EnrichedResult[] = (artistsRaw.data ?? []).map((a: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const exhibitions: SubResult[] = []
    const readings: SubResult[] = []
    const seenPreread = new Set<string>()

    for (const ea of a.exhibition_artists ?? []) {
      const ex = ea.exhibitions as any // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!ex || ex.status !== 'published') continue
      exhibitions.push({
        id: ex.id,
        title: ex.show_title,
        image_url: ex.image_url ?? null,
        url: `/exhibitions/${ex.id}`,
        is_external: false,
        subtitle: ex.venues?.name ?? null,
      })
      const isSolo = (exhibitionArtistCount.get(ex.id) ?? 1) === 1
      const artistNameLower = a.name.toLowerCase()
      for (const pr of ex.prereads ?? []) {
        const p = pr as any // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!p.article_url || seenPreread.has(p.id)) continue
        // For group shows, only include a preread if the artist's name appears in the title or summary
        if (!isSolo) {
          const inTitle = (p.article_title ?? '').toLowerCase().includes(artistNameLower)
          const inSummary = (p.summary ?? '').toLowerCase().includes(artistNameLower)
          if (!inTitle && !inSummary) continue
        }
        seenPreread.add(p.id)
        readings.push({
          id: p.id,
          title: p.article_title ?? p.article_url,
          image_url: p.thumbnail_url ?? null,
          url: p.article_url,
          is_external: true,
          subtitle: p.publication ?? null,
        })
      }
    }

    // Supplement with readings_tags if populated
    for (const rd of artistReadingsMap.get(a.id) ?? []) {
      if (!seenPreread.has(rd.id)) readings.push(rd)
    }

    return {
      id: a.id,
      name: a.name,
      category: 'artist' as const,
      url: null,
      exhibitions,
      readings,
      exhibition_count: exhibitions.length,
      reading_count: readings.length,
    }
  })

  // Enriched institution results — currently showing exhibitions + their prereads
  const institutionResults: EnrichedResult[] = (institutionsRaw.data ?? []).map((g: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const seenEx = new Set<string>()
    const seenPreread = new Set<string>()
    const exhibitions: SubResult[] = []
    const readings: SubResult[] = []

    for (const v of g.venues ?? []) {
      for (const ex of v.exhibitions ?? []) {
        const e = ex as any // eslint-disable-line @typescript-eslint/no-explicit-any
        if (e.status !== 'published') continue
        if (e.start_date && e.start_date > today) continue
        if (e.end_date && e.end_date < today) continue
        if (seenEx.has(e.id)) continue
        seenEx.add(e.id)
        exhibitions.push({
          id: e.id,
          title: e.show_title,
          image_url: e.image_url ?? null,
          url: `/exhibitions/${e.id}`,
          is_external: false,
          subtitle: null,
        })
        for (const pr of e.prereads ?? []) {
          const p = pr as any // eslint-disable-line @typescript-eslint/no-explicit-any
          if (!p.article_url || seenPreread.has(p.id)) continue
          seenPreread.add(p.id)
          readings.push({
            id: p.id,
            title: p.article_title ?? p.article_url,
            image_url: p.thumbnail_url ?? null,
            url: p.article_url,
            is_external: true,
            subtitle: p.publication ?? null,
          })
        }
      }
    }

    // Supplement with readings_tags if populated
    for (const rd of galleryReadingsMap.get(g.id) ?? []) {
      if (!seenPreread.has(rd.id)) readings.push(rd)
    }

    return {
      id: g.id,
      name: g.name,
      category: 'institution' as const,
      url: `/venues/${g.id}`,
      exhibitions,
      readings,
      exhibition_count: exhibitions.length,
      reading_count: readings.length,
    }
  })

  if (mode === 'dropdown') {
    return NextResponse.json({
      exhibitions: exhibitionResults.slice(0, 3),
      institutions: institutionResults.slice(0, 3),
      readings: readingResults.slice(0, 3),
      artists: artistResults.slice(0, 3),
    })
  }

  return NextResponse.json({
    exhibitions: sortFlat(exhibitionResults, q),
    institutions: sortEnriched(institutionResults, q),
    readings: sortFlat(readingResults, q),
    artists: sortEnriched(artistResults, q),
  })
}
