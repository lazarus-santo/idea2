const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

export async function geocodeAddress(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  if (!MAPBOX_TOKEN) return null
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${MAPBOX_TOKEN}&limit=1&country=US`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const feature = data.features?.[0]
    if (!feature) return null
    const [lng, lat] = feature.center as [number, number]
    return { lat, lng }
  } catch {
    return null
  }
}
