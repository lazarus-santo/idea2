import { NextResponse } from 'next/server'
import { CRAWL_MAX_STOPS, type CrawlRoute, type CrawlRouteSegment } from '@/lib/crawl-types'

/**
 * POST /api/crawl-route — the walking line drawn between a crawl's stops.
 *
 * ── WHY THIS IS NOT /api/directions ────────────────────────────────────────
 *
 * The existing route asks Mapbox the same question with `overview=false`,
 * which means "give me the duration, not the shape". It exists to tell the
 * map's itinerary panel how long a leg takes, and it is correct for that and
 * deliberately not changed here — the itinerary tool is out of scope.
 *
 * A crawl needs the shape: the actual pavement geometry, so the route can be
 * TRACED on the map rather than implied by a straight line between pins. That
 * is a different request (`geometries=geojson`, `overview=full`) with a
 * different, much larger response, and a different cache. Two routes rather
 * than one with a flag, because the itinerary panel should not start paying
 * for geometry it does not draw.
 *
 * ── ONE REQUEST PER LEG, NOT ONE PER ROUTE ─────────────────────────────────
 *
 * Mapbox will take up to twenty-five waypoints in a single Directions call and
 * hand back one geometry for the whole thing, which would be one request
 * instead of twenty-four. It is not used, and the reason is the brief's
 * fallback rule.
 *
 * With one call, a single unroutable pair fails the WHOLE route: Mapbox
 * answers NoRoute for the request, not for the leg, and there is no way to
 * recover which pair was the problem or to keep the other twenty-three real
 * legs. The route would collapse to straight lines everywhere, or to nothing.
 *
 * Per leg, a failure is contained to the leg that failed. That leg is drawn as
 * a straight line between its two pins, every other leg keeps its real walking
 * geometry, and the response says exactly how many fell back so the builder
 * can say so rather than presenting a guess as a measurement.
 *
 * WHAT COUNTS AS A FAILURE, all handled identically and all reported: Mapbox
 * answers NoRoute or NoSegment (a stop nowhere near a walkable street), the
 * request times out, the API returns a non-200, or MAPBOX_SERVER_TOKEN is not
 * set at all. The last is worth naming: without the token every leg falls back,
 * so the route still draws and the builder still says the line is approximate,
 * rather than the map silently showing nothing.
 *
 * ── THE TOKEN IS THE SERVER'S ──────────────────────────────────────────────
 *
 * MAPBOX_SERVER_TOKEN, as in lib/geocode.ts and /api/directions. The public
 * token in the browser is URL-restricted and was getting 403s from the
 * Directions API, which is why those two moved server-side; a third caller
 * making the same mistake would fail the same way.
 */

/** Mapbox's ceiling for one Directions call, and migration_v66's for one crawl. */
const MAX_POINTS = CRAWL_MAX_STOPS

/**
 * Module-level cache, surviving across requests in the same process — the same
 * arrangement /api/directions uses.
 *
 * It earns more here than there. A reorder does not change which places are
 * adjacent to which in most of a route, and every redraw asks for the same
 * pairs again; walking geometry between two fixed addresses does not change
 * between one request and the next. Keyed on the pair rounded to five decimal
 * places — about a metre, well under the precision any of these coordinates
 * actually have.
 *
 * ONLY SUCCESSES ARE CACHED. A straight-line fallback is a failure, and a
 * transient one — a timeout, a rate limit — must not become permanent for the
 * life of the process.
 */
const cache = new Map<string, { geometry: [number, number][]; distance: number; duration: number }>()

interface Point {
  /** Index into the crawl's stop list, so a leg can be matched to its two ends. */
  index: number
  lng: number
  lat: number
}

function key(a: Point, b: Point): string {
  return `${a.lng.toFixed(5)},${a.lat.toFixed(5)}_${b.lng.toFixed(5)},${b.lat.toFixed(5)}`
}

/** The straight line between two stops. Two points, and honest about being two points. */
function straightLine(a: Point, b: Point): CrawlRouteSegment {
  return {
    from_index: a.index,
    to_index: b.index,
    mode: 'straight',
    geometry: [[a.lng, a.lat], [b.lng, b.lat]],
    // Null rather than the crow-flies distance. A number here would be read as
    // "how far you walk", and the whole reason this leg exists is that nobody
    // knows. Reporting the straight-line distance as a walking distance would
    // be the silent gap the fallback is supposed to avoid.
    distance_meters: null,
    duration_minutes: null,
  }
}

async function walkingLeg(a: Point, b: Point, token: string | undefined): Promise<CrawlRouteSegment> {
  if (!token) return straightLine(a, b)

  const cached = cache.get(key(a, b))
  if (cached) {
    return {
      from_index: a.index,
      to_index: b.index,
      mode: 'walking',
      geometry: cached.geometry,
      distance_meters: cached.distance,
      duration_minutes: cached.duration,
    }
  }

  const coords = `${a.lng},${a.lat};${b.lng},${b.lat}`
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}` +
    `?access_token=${token}&geometries=geojson&overview=full`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return straightLine(a, b)

    const json = await res.json()
    const route = json.routes?.[0]
    const line = route?.geometry?.coordinates

    // A route with fewer than two points is not a line. Treated as a failure
    // rather than drawn, because a one-point "line" renders as nothing at all
    // and would look like a leg that was never requested.
    if (!Array.isArray(line) || line.length < 2) return straightLine(a, b)

    const geometry = line as [number, number][]
    const distance = typeof route.distance === 'number' ? Math.round(route.distance) : 0
    const duration = typeof route.duration === 'number' ? Math.round(route.duration / 60) : 0

    cache.set(key(a, b), { geometry, distance, duration })

    return {
      from_index: a.index,
      to_index: b.index,
      mode: 'walking',
      geometry,
      distance_meters: distance,
      duration_minutes: duration,
    }
  } catch {
    // Timeouts and network failures land here, alongside a malformed response.
    // All of them mean the same thing to the person looking at the map: this
    // leg is a straight line and is labelled as one.
    return straightLine(a, b)
  }
}

export async function POST(request: Request) {
  let body: { points?: Point[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const points = (body.points ?? []).filter(
    (p): p is Point =>
      !!p &&
      Number.isFinite(p.lng) &&
      Number.isFinite(p.lat) &&
      Number.isInteger(p.index)
  )

  // Nothing to draw between one pin. Not an error — it is what a crawl with a
  // single stop looks like, and the builder asks for the route either way.
  if (points.length < 2) {
    return NextResponse.json({ segments: [], fallback_count: 0 } satisfies CrawlRoute)
  }

  if (points.length > MAX_POINTS) {
    return NextResponse.json({ error: 'too_many_points' }, { status: 400 })
  }

  const token = process.env.MAPBOX_SERVER_TOKEN
  if (!token) {
    // Said once per request rather than once per leg, which is the difference
    // between a line in the log and twenty-four.
    console.warn('MAPBOX_SERVER_TOKEN not set — crawl route falls back to straight lines')
  }

  // In parallel. The legs are independent, and a twenty-five-stop crawl done in
  // sequence at eight seconds of timeout apiece could hold a request open for
  // three minutes.
  const segments = await Promise.all(
    points.slice(0, -1).map((from, i) => walkingLeg(from, points[i + 1], token))
  )

  return NextResponse.json({
    segments,
    fallback_count: segments.filter((s) => s.mode === 'straight').length,
  } satisfies CrawlRoute)
}
