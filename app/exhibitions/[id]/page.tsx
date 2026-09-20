import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getOwnLog } from '@/lib/exhibition-logs'
import ExhibitionDetail from '@/components/ExhibitionDetail'
import { resolveExhibitionLocation } from '@/lib/exhibition-location'
import type { ExhibitionDetailData, CoverageDisplayItem } from '@/lib/types'
import { prereadsToCoverageDisplay } from '@/lib/coverage-display'
import type { InstitutionType } from '@/lib/institution-types'

interface PageProps {
  params: Promise<{ id: string }>
}

// exhibitors is jsonb, so both shapes are readable: the original flat string[]
// and the current {name, section} form used once fairs gained per-section pages.
// Normalising on read means no backfill was needed for rows written under the
// old shape.
function normalizeExhibitors(raw: unknown): { name: string; section: string | null }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((e) => {
      if (typeof e === 'string') return { name: e, section: null }
      if (e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string') {
        const o = e as { name: string; section?: unknown }
        return { name: o.name, section: typeof o.section === 'string' ? o.section : null }
      }
      return null
    })
    .filter((e): e is { name: string; section: string | null } => e !== null)
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
      show_location,
      show_location_2,
      show_location_3,
      show_location_neighborhood,
      show_location_latitude,
      show_location_longitude,
      preread_type,
      hide_artist_names,
      venues!inner(name, address, neighborhood, institution_id, latitude, longitude, institutions(name, type, exhibitors)),
      exhibition_artists(artists!inner(name)),
      prereads(id, article_title, publication, article_url, thumbnail_url, author, published_date, item_coverage_type, row_status)
    `)
    .eq('id', id)
    .eq('status', 'published')
    .single()

  if (error || !data) notFound()

  const raw = data as typeof data & {
    venues: { name: string; address: string | null; neighborhood: string | null; institution_id: string | null; latitude: number | null; longitude: number | null; institutions: { name: string; type: string | null; exhibitors: unknown } | null }
    exhibition_artists: { artists: { name: string } }[]
    prereads: { id: string; article_title: string | null; publication: string | null; article_url: string | null; thumbnail_url: string | null; author: string | null; published_date: string | null; item_coverage_type: string | null; row_status: string }[]
    description: string | null
    press_release: string | null
    address_override: string | null
    address_override_neighborhood: string | null
    override_latitude: number | null
    override_longitude: number | null
    show_location: string | null
    show_location_2: string | null
    show_location_3: string | null
    show_location_neighborhood: string | null
    show_location_latitude: number | null
    show_location_longitude: number | null
    is_ongoing: boolean | null
    preread_type: string | null
  }

  // address_override → show_location → venue — see lib/exhibition-location.ts.
  const location = resolveExhibitionLocation(raw, raw.venues)

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
      // Blanked rows (flagged by Agent 2, or hidden by an admin) stay admin-only.
      .filter((p) => !!p.article_url && p.row_status === 'active')
      .sort((a, b) => urlTier(a.article_url) - urlTier(b.article_url))
  }

  // ── Museum and fair coverage: prereads rows, same table and visibility rule as
  // the gallery path above (see lib/coverage-display.ts for why this no longer reads
  // exhibitions.coverage). exhibition_coverage is consulted only to link an item to
  // its /readings page when it is also a curated reading — it no longer adds items
  // of its own, since anything shown must be a prereads row an admin can blank.
  // Only source='agent2' links: Agent 3's cross-linking was unverified substring
  // matching (the "Kleinert" bug) and is excluded.
  let mergedCoverage: CoverageDisplayItem[] = []
  if (prereadType === 'coverage_only') {
    const { data: coverageLinksRaw } = await getSupabaseAdmin()
      .from('exhibition_coverage')
      .select('readings!inner(id, article_url)')
      .eq('exhibition_id', id)
      .eq('source', 'agent2')

    const readingIdByUrl = new Map<string, string>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (coverageLinksRaw ?? []).map((row: any) => [row.readings.article_url, row.readings.id])
    )

    mergedCoverage = prereadsToCoverageDisplay(raw.prereads ?? [], readingIdByUrl)
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
    resolved_address: location.address,
    resolved_addresses: location.addresses,
    address_override: raw.address_override,
    address_override_neighborhood: raw.address_override_neighborhood,
    lat: location.lat,
    lng: location.lng,
    // Hidden means not displayed, never not stored: the names are still in
    // exhibition_artists, and Agent 2's coverage and preread matching still read them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    artists: raw.hide_artist_names ? [] : (raw.exhibition_artists ?? []).map((ea: any) => ea.artists?.name).filter(Boolean) as string[],
    preread_type: prereadType,
    venue_type: (raw.venues.institutions?.type ?? 'gallery') as InstitutionType,
    exhibitors: normalizeExhibitors(raw.venues.institutions?.exhibitors),
    prereads: mergedPrereads,
    coverage: mergedCoverage,
  }

  // The page's own read above uses the service key, which is right for public
  // exhibition data and wrong for anything about the visitor. The log is read
  // through their session instead, so RLS decides it: migration_v62 narrows
  // that table to the caller's own rows, and a person can only ever see their
  // own entry here. Other people's logs live on their profiles.
  const viewer = await getCurrentUser()
  const ownLog = await getOwnLog(viewer?.id ?? null, id)

  return (
    <ExhibitionDetail
      exhibition={exhibition}
      viewerId={viewer?.id ?? null}
      log={ownLog}
    />
  )
}
