import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { geocodeAddress } from '@/lib/geocode'
import { resolveExhibitionLocation } from '@/lib/exhibition-location'
import type { MapExhibition } from '@/lib/types'

export async function GET() {
  const today = new Date().toISOString().split('T')[0]

  const { data, error } = await getSupabaseAdmin()
    .from('exhibitions')
    .select(`
      id,
      show_title,
      start_date,
      end_date,
      is_ongoing,
      image_url,
      address_override,
      override_latitude,
      override_longitude,
      show_location,
      show_location_latitude,
      show_location_longitude,
      venues!inner(id, name, latitude, longitude, hours, address, institution_id,
        institutions!inner(id, name, type)
      ),
      exhibition_artists(artists(name))
    `)
    .eq('status', 'published')
    .or(`end_date.gte.${today},end_date.is.null`)
    .order('start_date', { ascending: true })

  if (error) {
    console.error('map-exhibitions fetch failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
  const cutoff = ninetyDaysAgo.toISOString().split('T')[0]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates = ((data ?? []) as any[])
    // Fairs are exempt from the "already opened" rule, same as in
    // /api/exhibitions: a fair runs about four days a year, so the map would
    // otherwise only ever show one during those four. The end_date filter above
    // still drops it once the fair closes.
    .filter((ex) => ex.venues?.institutions?.type === 'fair' || !ex.start_date || ex.start_date <= today)
    .filter((ex) => ex.is_ongoing || ex.end_date || (ex.start_date && ex.start_date >= cutoff))
    // Keep if anything can place it: venue coords, show_location coords, or an address_override to geocode
    .filter((ex) =>
      (ex.venues?.latitude && ex.venues?.longitude) ||
      (ex.show_location_latitude && ex.show_location_longitude) ||
      ex.address_override
    )

  // Geocode address overrides that don't have cached coordinates yet
  const needsGeocode = candidates.filter(
    (ex) => ex.address_override && (!ex.override_latitude || !ex.override_longitude)
  )

  if (needsGeocode.length > 0) {
    const supabase = getSupabaseAdmin()
    await Promise.all(
      needsGeocode.map(async (ex) => {
        const coords = await geocodeAddress(ex.address_override)
        if (!coords) return
        // Mutate in-place so the map below picks up the coords without a re-fetch
        ex.override_latitude = coords.lat
        ex.override_longitude = coords.lng
        // Persist so subsequent loads are instant
        await supabase
          .from('exhibitions')
          .update({ override_latitude: coords.lat, override_longitude: coords.lng })
          .eq('id', ex.id)
      })
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalized: MapExhibition[] = candidates.map((ex: any) => {
    const { venues: venueData, exhibition_artists, ...rest } = ex
    const institution = venueData.institutions ?? null

    // address_override → show_location → venue, for both the pin and the address.
    // venue_lat / venue_lng keep their names: they're the map's existing contract.
    const location = resolveExhibitionLocation(rest, venueData)

    return {
      id: rest.id,
      show_title: rest.show_title,
      start_date: rest.start_date,
      end_date: rest.end_date,
      image_url: rest.image_url,
      institution_name: institution?.name ?? venueData.name,
      institution_id: institution?.id ?? null,
      venue_type: (institution?.type ?? 'gallery') as MapExhibition['venue_type'],
      venue_id: venueData.id,
      venue_name: venueData.name,
      venue_lat: location.lat,
      venue_lng: location.lng,
      venue_hours: venueData.hours ?? null,
      venue_address: location.address,
      artists: (exhibition_artists ?? [])
        .map((ea: { artists: { name: string } | null }) => ea.artists?.name)
        .filter(Boolean) as string[],
    } satisfies MapExhibition
  }).filter((ex: MapExhibition) => ex.venue_lat && ex.venue_lng) // drop anything still unresolvable

  return NextResponse.json(normalized)
}
