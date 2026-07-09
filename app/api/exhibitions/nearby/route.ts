import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import type { NearbyExhibition } from '@/lib/types'

function haversineDistanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3959
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// GET /api/exhibitions/nearby?lat=&lng=&exclude=
// Returns published, currently-running exhibitions within 1 mile of the given coordinates.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const lat = parseFloat(searchParams.get('lat') ?? '')
  const lng = parseFloat(searchParams.get('lng') ?? '')
  const exclude = searchParams.get('exclude') ?? ''

  if (isNaN(lat) || isNaN(lng)) {
    return NextResponse.json({ error: 'lat and lng are required' }, { status: 400 })
  }

  const today = new Date().toISOString().split('T')[0]

  const { data, error } = await getSupabaseAdmin()
    .from('exhibitions')
    .select(`
      id,
      show_title,
      end_date,
      image_url,
      address_override,
      override_latitude,
      override_longitude,
      venues!inner(id, name, latitude, longitude,
        institutions(id, name)
      ),
      exhibition_artists(artists(name))
    `)
    .eq('status', 'published')
    .lte('start_date', today)
    .or(`end_date.gte.${today},end_date.is.null`)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nearby: NearbyExhibition[] = ((data ?? []) as any[])
    .filter((ex) => ex.id !== exclude)
    .map((ex) => {
      const hasOverride = ex.address_override && ex.override_latitude && ex.override_longitude
      const resolvedLat = hasOverride
        ? Number(ex.override_latitude)
        : ex.venues?.latitude ? Number(ex.venues.latitude) : null
      const resolvedLng = hasOverride
        ? Number(ex.override_longitude)
        : ex.venues?.longitude ? Number(ex.venues.longitude) : null

      if (!resolvedLat || !resolvedLng) return null

      return {
        id: ex.id,
        show_title: ex.show_title,
        institution_name: ex.venues?.institutions?.name ?? ex.venues?.name ?? '',
        institution_id: ex.venues?.institutions?.id ?? null,
        venue_id: ex.venues?.id,
        image_url: ex.image_url,
        end_date: ex.end_date,
        artists: (ex.exhibition_artists ?? [])
          .map((ea: { artists: { name: string } | null }) => ea.artists?.name)
          .filter(Boolean) as string[],
        lat: resolvedLat,
        lng: resolvedLng,
      } satisfies NearbyExhibition
    })
    .filter((ex): ex is NearbyExhibition => ex !== null)
    .filter((ex) => haversineDistanceMiles(lat, lng, ex.lat, ex.lng) <= 1)

  return NextResponse.json(nearby)
}
