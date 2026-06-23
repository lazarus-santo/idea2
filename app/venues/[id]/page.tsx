import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase'
import VenuePage from '@/components/VenuePage'
import type { VenueExhibition, VenuePreread, VenueInstitutionPin } from '@/lib/types'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function VenueRoute({ params }: PageProps) {
  const { id } = await params
  const supabase = getSupabaseAdmin()

  // Institution (org brand) info
  const { data: institution, error: institutionError } = await supabase
    .from('institutions')
    .select('id, name, type, website')
    .eq('id', id)
    .single()

  if (institutionError || !institution) notFound()

  // All venues for this institution (address + coordinates)
  const { data: venueRows } = await supabase
    .from('venues')
    .select('id, name, address, neighborhood, latitude, longitude')
    .eq('institution_id', id)
    .eq('active', true)

  const primaryVenue = venueRows?.[0] ?? null
  const venueIds = (venueRows ?? []).map((v) => v.id)

  // Exhibitions + prereads for this institution
  const exhibitions: VenueExhibition[] = []
  const prereads: VenuePreread[] = []

  if (venueIds.length > 0) {
    const { data: exData } = await supabase
      .from('exhibitions')
      .select(`
        id, show_title, start_date, end_date, image_url,
        exhibition_artists(artists!inner(name)),
        prereads(id, article_title, publication, article_url, created_at)
      `)
      .in('venue_id', venueIds)
      .eq('status', 'published')
      .order('end_date', { ascending: false })

    for (const ex of exData ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = ex as any
      exhibitions.push({
        id: raw.id,
        show_title: raw.show_title,
        start_date: raw.start_date,
        end_date: raw.end_date,
        image_url: raw.image_url,
        artists: (raw.exhibition_artists ?? [])
          .map((ea: { artists: { name: string } | null }) => ea.artists?.name)
          .filter(Boolean) as string[],
      })
      for (const p of raw.prereads ?? []) {
        prereads.push(p as VenuePreread)
      }
    }

    prereads.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
  }

  // All active venues with coordinates for the map
  const { data: allVenueRows } = await supabase
    .from('venues')
    .select('id, institution_id, name, latitude, longitude')
    .eq('active', true)
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)

  const allVenues: VenueInstitutionPin[] = (allVenueRows ?? []).map((v) => ({
    id: v.id,
    institution_id: v.institution_id ?? null,
    name: v.name,
    lat: v.latitude ?? null,
    lng: v.longitude ?? null,
  }))

  return (
    <VenuePage
      venue={{ id: institution.id, name: institution.name, type: institution.type }}
      institution={
        primaryVenue
          ? {
              address: primaryVenue.address ?? null,
              lat: primaryVenue.latitude ?? null,
              lng: primaryVenue.longitude ?? null,
            }
          : null
      }
      exhibitions={exhibitions}
      prereads={prereads}
      allInstitutions={allVenues}
    />
  )
}
