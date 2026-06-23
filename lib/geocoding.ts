import { getSupabaseAdmin } from './supabase'

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (!token) {
    console.warn('NEXT_PUBLIC_MAPBOX_TOKEN not set — skipping geocoding')
    return null
  }

  try {
    const res = await fetch(
      `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(address)}&limit=1&access_token=${token}`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) {
      console.error(`Mapbox geocoding failed: HTTP ${res.status}`)
      return null
    }
    const json = await res.json()
    const feature = json.features?.[0]
    if (!feature) return null
    const [lng, lat] = feature.geometry.coordinates as [number, number]
    return { lat, lng }
  } catch (err) {
    console.error('Geocoding error:', err)
    return null
  }
}

// Geocodes a venue's address and writes lat/lng to the venues table.
// No-ops if address is null or coordinates are already present.
export async function geocodeVenueIfNeeded(
  venueId: string,
  address: string | null,
  latitude: number | null | undefined,
  longitude: number | null | undefined
): Promise<void> {
  if (latitude && longitude) return
  if (!address) return

  const coords = await geocodeAddress(address)
  if (!coords) return

  const { error } = await getSupabaseAdmin()
    .from('venues')
    .update({ latitude: coords.lat, longitude: coords.lng })
    .eq('id', venueId)

  if (error) {
    console.error(`Failed to write geocoded coordinates for venue ${venueId}:`, error.message)
  } else {
    console.log(`Geocoded venue ${venueId} (${address}): ${coords.lat}, ${coords.lng}`)
  }
}
