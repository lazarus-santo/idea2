import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { geocodeAddress } from '@/lib/geocode'
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
      image_url,
      address_override,
      override_latitude,
      override_longitude,
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
    .filter((ex) => !ex.start_date || ex.start_date <= today)
    .filter((ex) => ex.end_date || (ex.start_date && ex.start_date >= cutoff))
    // Keep if venue has coords OR has an address_override to geocode
    .filter((ex) => (ex.venues?.latitude && ex.venues?.longitude) || ex.address_override)

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

    // Resolved coordinates: address_override geocode takes precedence over venue lat/lng
    const hasOverride = rest.address_override && rest.override_latitude && rest.override_longitude
    const resolvedLat = hasOverride
      ? Number(rest.override_latitude)
      : venueData.latitude ? Number(venueData.latitude) : null
    const resolvedLng = hasOverride
      ? Number(rest.override_longitude)
      : venueData.longitude ? Number(venueData.longitude) : null

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
      venue_lat: resolvedLat,
      venue_lng: resolvedLng,
      venue_hours: venueData.hours ?? null,
      venue_address: rest.address_override ?? venueData.address ?? null,
      artists: (exhibition_artists ?? [])
        .map((ea: { artists: { name: string } | null }) => ea.artists?.name)
        .filter(Boolean) as string[],
    } satisfies MapExhibition
  }).filter((ex: MapExhibition) => ex.venue_lat && ex.venue_lng) // drop anything still unresolvable

  return NextResponse.json(normalized)
}
