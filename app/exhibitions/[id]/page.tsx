import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase'
import ExhibitionDetail from '@/components/ExhibitionDetail'
import type { ExhibitionDetailData } from '@/lib/types'

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

  // ── Merge prereads with River-linked readings ─────────────────────────────────
  let mergedPrereads: ExhibitionDetailData['prereads'] = []
  if (prereadType === 'full') {
    const { data: linkedReadingsRaw } = await getSupabaseAdmin()
      .from('readings_tags')
      .select('readings!inner(id, headline, article_url, thumbnail_url, published_at, publications(name))')
      .eq('exhibition_id', id)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkedPrereads: ExhibitionDetailData['prereads'] = (linkedReadingsRaw ?? []).map((tag: any) => {
      const r = tag.readings
      return {
        id: r.id,
        article_title: r.headline,
        publication: r.publications?.name ?? null,
        article_url: r.article_url,
        thumbnail_url: r.thumbnail_url ?? null,
        _published_at: r.published_at as string | null,
      }
    })

    const seenUrls = new Set<string>()
    const allPrereads = [...(raw.prereads ?? []), ...linkedPrereads].filter((p) => {
      if (!p.article_url || seenUrls.has(p.article_url)) return false
      seenUrls.add(p.article_url)
      return true
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    allPrereads.sort((a, b) => {
      const tierDiff = urlTier(a.article_url) - urlTier(b.article_url)
      if (tierDiff !== 0) return tierDiff
      const dateA = (a as any)._published_at ? new Date((a as any)._published_at).getTime() : 0
      const dateB = (b as any)._published_at ? new Date((b as any)._published_at).getTime() : 0
      return dateB - dateA
    })
    mergedPrereads = allPrereads
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
  }

  return <ExhibitionDetail exhibition={exhibition} />
}
