const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

/**
 * Forward-geocode a street address. Returns null when the address cannot be
 * resolved — callers treat coordinates as optional.
 *
 * KNOWN ISSUE (2026-08-05): NEXT_PUBLIC_MAPBOX_TOKEN has URL restrictions set in
 * the Mapbox account, so it only works from a browser sending a matching
 * Referer. Server-side calls have no Referer and get 403 on every request —
 * verified: the identical query returns 200 with `Referer: https://idea2.xyz/`
 * and 403 without. Map rendering in the browser is unaffected; it is only
 * server-side geocoding that is dead, here and in app/api/admin/seed/enrich.
 *
 * The fix is on the Mapbox side: either drop the URL restriction, or issue a
 * second unrestricted token for server use and read it here. Spoofing a Referer
 * from the server would work but would defeat a control that was set
 * deliberately, so it is not done.
 *
 * Until then every failure is logged rather than silently swallowed — the whole
 * reason this went unnoticed is that the previous version returned null on any
 * error with no output, so a venue simply ended up without a map pin.
 */
export async function geocodeAddress(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  if (!MAPBOX_TOKEN) {
    console.warn('geocodeAddress: NEXT_PUBLIC_MAPBOX_TOKEN is not set — skipping')
    return null
  }
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${MAPBOX_TOKEN}&limit=1&country=US`
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(
        `geocodeAddress: Mapbox returned ${res.status} for "${address}"` +
        (res.status === 403 ? ' — token is URL-restricted and rejects server-side requests' : '')
      )
      return null
    }
    const data = await res.json()
    const feature = data.features?.[0]
    if (!feature) {
      console.warn(`geocodeAddress: no match for "${address}"`)
      return null
    }
    const [lng, lat] = feature.center as [number, number]
    return { lat, lng }
  } catch (err) {
    console.warn(`geocodeAddress: request failed for "${address}":`, (err as Error).message)
    return null
  }
}
