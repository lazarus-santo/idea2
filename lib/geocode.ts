// Server-only Mapbox token, deliberately not the NEXT_PUBLIC_ one.
//
// NEXT_PUBLIC_MAPBOX_TOKEN carries URL restrictions so it can be exposed in the
// browser bundle safely. Those restrictions are enforced by Referer, and a
// server request sends none, so every server-side call returned 403 — verified
// 2026-08-05: the identical query returned 200 with `Referer: https://idea2.xyz/`
// and 403 without, on both the v5 and v6 endpoints. It failed silently because
// this function returns null on any error, so a venue simply ended up with no
// coordinates and no pin.
//
// MAPBOX_SERVER_TOKEN is unrestricted and never reaches the browser. The public
// token is still correct for the map components — this file must not use it.
const MAPBOX_TOKEN = process.env.MAPBOX_SERVER_TOKEN

/**
 * Forward-geocode a street address. Returns null when the address cannot be
 * resolved — callers treat coordinates as optional.
 *
 * Failures are logged rather than swallowed: the silent null is exactly what let
 * the 403 above go unnoticed for as long as it did.
 */
export async function geocodeAddress(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  if (!MAPBOX_TOKEN) {
    console.warn('geocodeAddress: MAPBOX_SERVER_TOKEN is not set — skipping')
    return null
  }
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${MAPBOX_TOKEN}&limit=1&country=US`
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(
        `geocodeAddress: Mapbox returned ${res.status} for "${address}"` +
        (res.status === 403 ? ' — token rejected; check MAPBOX_SERVER_TOKEN has no URL restrictions' : '')
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
