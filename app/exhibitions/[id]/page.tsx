import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase'
import ExhibitionDetail from '@/components/ExhibitionDetail'
import type { ExhibitionDetailData, CoverageItem, CoverageDisplayItem } from '@/lib/types'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ExhibitionPage({ params }: PageProps) {
  const { id } = await params

  const { data, error } = await getSupabaseAdmin()
    .from('exhibitions')
    .select(`
      id,
      show_title,
      start_date,
      end_date,
      description,
      press_release,
      image_url,
      address_override,
      address_override_neighborhood,
      override_latitude,
      override_longitude,
      preread_type,
      coverage,
      venues!inner(name, address, neighborhood, institution_id, latitude, longitude, institutions(name)),
      exhibition_artists(artists!inner(name)),
      prereads(id, article_title, publication, article_url, thumbnail_url)
    `)
    .eq('id', id)
    .eq('status', 'published')
    .single()

  if (error || !data) notFound()

  const raw = data as typeof data & {
    venues: { name: string; address: string | null; neighborhood: string | null; institution_id: string | null; latitude: number | null; longitude: number | null; institutions: { name: string } | null }
    exhibition_artists: { artists: { name: string } }[]
    prereads: { id: string; article_title: string | null; publication: string | null; article_url: string | null; thumbnail_url: string | null }[]
    description: string | null
    press_release: string | null
    address_override: string | null
    address_override_neighborhood: string | null
    override_latitude: number | null
    override_longitude: number | null
    is_ongoing: boolean | null
    preread_type: string | null
    coverage: CoverageItem[] | null
  }

  const hasOverride = raw.address_override && raw.override_latitude && raw.override_longitude
  const resolvedLat = hasOverride ? Number(raw.override_latitude) : raw.venues.latitude ? Number(raw.venues.latitude) : null
  const resolvedLng = hasOverride ? Number(raw.override_longitude) : raw.venues.longitude ? Number(raw.venues.longitude) : null

  const prereadType: 'full' | 'coverage_only' =
    raw.preread_type === 'coverage_only' ? 'coverage_only' : 'full'

  const TIER_1 = new Set(['artforum.com','frieze.com','theartnewspaper.com','hyperallergic.com','artnews.com','brooklynrail.org','bombmagazine.org','e-flux.com'])
  const TIER_2 = new Set(['newyorker.com','ft.com','vulture.com','nymag.com'])

  function urlTier(url: string | null): number {
    if (!url) return 3
    try {
      const host = new URL(url).hostname.replace(/^www\./, '')
      if (TIER_1.has(host)) return 1
      if (TIER_2.has(host)) return 2
      return 3
    } catch { return 3 }
  }

  // Prereads shown here are Agent 2's own output only — Agent 3's readings_tags cross-link
  // used to be merged in too, but that tagging is a raw substring match with no relevance
  // verification (proven live: it matched "Klein" inside "Kleinert," a venue name, and
  // surfaced an unrelated Hudson Valley gallery guide on Klein's own exhibition page).
  // Halted until Agent 3's tagging gets the same verification Agent 2 now has.
  let mergedPrereads: ExhibitionDetailData['prereads'] = []
  if (prereadType === 'full') {
    mergedPrereads = (raw.prereads ?? [])
      .filter((p) => !!p.article_url)
      .sort((a, b) => urlTier(a.article_url) - urlTier(b.article_url))
  }

  // ── Merge coverage jsonb with exhibition_coverage-linked readings (museums) ────
  // Only source='agent2' links are included — Agent 3's own cross-linking (tagReading in
  // readings-curator.ts) uses the same unverified substring matching that caused the
  // "Kleinert" bug on the gallery side, so it's excluded here until it gets a real
  // relevance check too.
  let mergedCoverage: CoverageDisplayItem[] = []
  if (prereadType === 'coverage_only') {
    const { data: coverageLinksRaw } = await getSupabaseAdmin()
      .from('exhibition_coverage')
      .select('reading_id, readings!inner(id, headline, article_url, author, thumbnail_url, published_at, publications(name))')
      .eq('exhibition_id', id)
      .eq('source', 'agent2')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkedReadingItems: CoverageDisplayItem[] = (coverageLinksRaw ?? []).map((row: any) => {
      const r = row.readings
      return {
        url: r.article_url,
        title: r.headline,
        author: r.author ?? null,
        publication: r.publications?.name ?? null,
        published_date: r.published_at ?? null,
        thumbnail_url: r.thumbnail_url ?? null,
        reading_id: r.id,
      }
    })

    const readingIdByUrl = new Map(linkedReadingItems.map((r) => [r.url, r.reading_id]))

    const seenUrls = new Set<string>()
    const fromCoverageJsonb: CoverageDisplayItem[] = (raw.coverage ?? [])
      .filter((c: CoverageItem) => !!c.url && !seenUrls.has(c.url) && seenUrls.add(c.url))
      .map((c: CoverageItem) => ({
        url: c.url,
        title: c.title,
        author: c.author,
        publication: c.publication,
        published_date: c.published_date,
        thumbnail_url: c.thumbnail_url,
        reading_id: readingIdByUrl.get(c.url),
      }))

    const extraFromLinks = linkedReadingItems.filter((r) => !seenUrls.has(r.url) && seenUrls.add(r.url))

    mergedCoverage = [...fromCoverageJsonb, ...extraFromLinks]
  }

  const exhibition: ExhibitionDetailData = {
    id: raw.id,
    show_title: raw.show_title,
    start_date: raw.start_date,
    end_date: raw.end_date,
    is_ongoing: raw.is_ongoing ?? false,
    press_release: raw.press_release ?? raw.description,
    image_url: raw.image_url,
    institution_name: raw.venues.institutions?.name ?? raw.venues.name,
    institution_id: raw.venues.institution_id ?? null,
    venue_address: raw.venues.address,
    venue_neighborhood: raw.venues.neighborhood,
    resolved_address: raw.address_override ?? raw.venues.address,
    address_override: raw.address_override,
    address_override_neighborhood: raw.address_override_neighborhood,
    lat: resolvedLat,
    lng: resolvedLng,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    artists: (raw.exhibition_artists ?? []).map((ea: any) => ea.artists?.name).filter(Boolean) as string[],
    preread_type: prereadType,
    prereads: mergedPrereads,
    coverage: mergedCoverage,
  }

  return <ExhibitionDetail exhibition={exhibition} />
}
