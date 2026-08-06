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
 * Geographic constraints for every geocode this app performs.
 *
 * Addresses reach the geocoder as bare street lines — "531 West 24th Street" —
 * because that is how galleries print them and how the seeder's suggest step
 * returns them. Searched against the whole of `country=US`, Mapbox answers with
 * whichever city matches first, and it is confidently wrong: 531 West 24th
 * Street resolves to Indianapolis, 522 West 22nd Street to Cedar Falls, Iowa,
 * and 537 West 20th Street to Kansas City. Every one is a real address; none is
 * in New York.
 *
 * NYC_BBOX is the hard constraint — a result outside it is not returned at all,
 * rather than merely ranked lower. NYC_PROXIMITY then orders what remains by
 * distance from midtown. This is an NYC-only product, so excluding everything
 * else is correct rather than merely convenient.
 *
 * Covers all five boroughs: west of Staten Island to east of Queens, south of
 * the Rockaways to north of the Bronx.
 */
export const NYC_BBOX = '-74.30,40.47,-73.68,40.93'
export const NYC_PROXIMITY = '-73.99,40.75'

/** Query string fragment shared by every Mapbox forward-geocode call. */
export const NYC_GEOCODE_PARAMS = `&country=US&bbox=${NYC_BBOX}&proximity=${NYC_PROXIMITY}`

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
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${MAPBOX_TOKEN}&limit=1${NYC_GEOCODE_PARAMS}`
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
      // With the bbox applied, no match usually means the address is outside NYC
      // rather than unparseable — which is the correct outcome for this product.
      console.warn(`geocodeAddress: no match within NYC for "${address}"`)
      return null
    }
    const [lng, lat] = feature.center as [number, number]
    return { lat, lng }
  } catch (err) {
    console.warn(`geocodeAddress: request failed for "${address}":`, (err as Error).message)
    return null
  }
}
