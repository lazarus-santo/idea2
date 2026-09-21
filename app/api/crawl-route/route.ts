import { NextResponse } from 'next/server'
import {
  CRAWL_MAX_STOPS,
  type CrawlRoute,
  type CrawlRouteRequestLeg,
  type CrawlRouteSegment,
  type TravelMode,
} from '@/lib/crawl-types'

/**
 * POST /api/crawl-route — the line drawn between a crawl's stops.
 *
 * ── WHY THIS IS NOT /api/directions ────────────────────────────────────────
 *
 * The existing route asks Mapbox the same question with `overview=false`,
 * which means "give me the duration, not the shape". It exists to tell the
 * itinerary panel how long a leg takes, and it is correct for that and
 * deliberately not changed here.
 *
 * A crawl needs the shape: the actual geometry, so the route can be TRACED on
 * the map rather than implied by a straight line between pins. That is a
 * different request (`geometries=geojson`, `overview=full`) with a different,
 * much larger response, and a different cache. Two routes rather than one with
 * a flag, because the itinerary panel should not start paying for geometry it
 * does not draw.
 *
 * ── EACH LEG IS ROUTED IN ITS OWN MODE ─────────────────────────────────────
 *
 * The request is a list of LEGS, each carrying its own two ends and its own
 * mode, and each is sent to Mapbox on the matching routing profile. A crawl
 * whose first leg is walked and whose second is driven gets a pavement line
 * and then a road line, because those are different routes over the same two
 * points — a driving leg follows one-way streets and avoids the pedestrian
 * cut-through that the walking leg takes.
 *
 * Drawing one profile for the whole route was the earlier behaviour and was
 * wrong in a quiet way: the line said "walk this" over a leg the person had
 * already told us they were driving.
 *
 * ── ONE REQUEST PER LEG, NOT ONE PER ROUTE ─────────────────────────────────
 *
 * Mapbox will take up to twenty-five waypoints in a single Directions call and
 * hand back one geometry. That is not used, for two reasons, and the second is
 * now the stronger one:
 *
 *   THE FALLBACK. With one call, a single unroutable pair fails the WHOLE
 *   route: Mapbox answers NoRoute for the request, not for the leg, and there
 *   is no way to recover which pair was the problem or to keep the other legs.
 *   Per leg, a failure is contained to the leg that failed.
 *
 *   THE PROFILE. A Directions call has ONE profile. A route with mixed modes
 *   cannot be expressed as a single call at all, whatever the fallback
 *   behaviour — so per-leg is not an optimisation to revisit, it is the only
 *   shape that can answer the question.
 *
 * WHAT COUNTS AS A FAILURE, all handled identically and all reported: Mapbox
 * answers NoRoute or NoSegment (a stop nowhere near a routable street), the
 * request times out, the API returns a non-200, or MAPBOX_SERVER_TOKEN is not
 * set at all. The last is worth naming: without the token every leg falls
 * back, so the route still draws and the map still says the line is
 * approximate, rather than showing nothing.
 *
 * A failed leg reports the mode it ASKED for, so the map can say which kind of
 * directions were missing rather than guessing.
 *
 * ── THE TOKEN IS THE SERVER'S ──────────────────────────────────────────────
 *
 * MAPBOX_SERVER_TOKEN, as in lib/geocode.ts and /api/directions. The public
 * token in the browser is URL-restricted and was getting 403s from the
 * Directions API, which is why those two moved server-side; a third caller
 * making the same mistake would fail the same way.
 */

/** Mapbox's ceiling for one call, and migration_v66's for one crawl. */
const MAX_LEGS = CRAWL_MAX_STOPS

/**
 * Module-level cache, surviving across requests in the same process — the same
 * arrangement /api/directions uses.
 *
 * It earns more here than there. A reorder does not change which places are
 * adjacent to which in most of a route, and every redraw asks for the same
 * pairs again; the route between two fixed addresses does not change between
 * one request and the next.
 *
 * THE KEY INCLUDES THE MODE. Without it, walking a leg and then switching it
 * to driving would hand back the pavement geometry for the driving line —
 * cached under a key that did not record what was actually asked. Rounded to
 * five decimal places, about a metre, well under the precision these
 * coordinates actually have.
 *
 * ONLY SUCCESSES ARE CACHED. A straight-line fallback is a failure, and a
 * transient one — a timeout, a rate limit — must not become permanent for the
 * life of the process.
 */
const cache = new Map<string, { geometry: [number, number][]; distance: number; duration: number }>()

function cacheKey(leg: CrawlRouteRequestLeg): string {
  const [aLng, aLat] = leg.from
  const [bLng, bLat] = leg.to
  return `${leg.mode}:${aLng.toFixed(5)},${aLat.toFixed(5)}_${bLng.toFixed(5)},${bLat.toFixed(5)}`
}

/** The straight line between two stops. Two points, and honest about being two. */
function straightLine(leg: CrawlRouteRequestLeg): CrawlRouteSegment {
  return {
    from_index: leg.from_index,
    to_index: leg.to_index,
    // The mode that was ASKED for, kept even though nothing was routed — it is
    // what lets the map say "no driving directions" rather than a generic
    // apology, or worse, the wrong mode's name.
    travel_mode: leg.mode,
    drawn: 'straight',
    geometry: [leg.from, leg.to],
    // Null rather than the crow-flies distance. A number here would be read as
    // "how far you travel", and the whole reason this leg exists is that
    // nobody knows. Reporting a straight-line distance as a routed one would
    // be the silent gap the fallback is supposed to avoid.
    distance_meters: null,
    duration_minutes: null,
  }
}

async function routeLeg(
  leg: CrawlRouteRequestLeg,
  token: string | undefined
): Promise<CrawlRouteSegment> {
  if (!token) return straightLine(leg)

  const cached = cache.get(cacheKey(leg))
  if (cached) {
    return {
      from_index: leg.from_index,
      to_index: leg.to_index,
      travel_mode: leg.mode,
      drawn: 'route',
      geometry: cached.geometry,
      distance_meters: cached.distance,
      duration_minutes: cached.duration,
    }
  }

  // `walking` and `driving` are Mapbox's own profile names, which is why the
  // mode goes into the path unchanged. It is validated against the union
  // before it gets here, so nothing a caller sends reaches this URL untested.
  const coords = `${leg.from[0]},${leg.from[1]};${leg.to[0]},${leg.to[1]}`
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${leg.mode}/${coords}` +
    `?access_token=${token}&geometries=geojson&overview=full`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return straightLine(leg)

    const json = await res.json()
    const route = json.routes?.[0]
    const line = route?.geometry?.coordinates

    // A route with fewer than two points is not a line. Treated as a failure
    // rather than drawn, because a one-point "line" renders as nothing at all
    // and would look like a leg that was never requested.
    if (!Array.isArray(line) || line.length < 2) return straightLine(leg)

    const geometry = line as [number, number][]
    const distance = typeof route.distance === 'number' ? Math.round(route.distance) : 0
    const duration = typeof route.duration === 'number' ? Math.round(route.duration / 60) : 0

    cache.set(cacheKey(leg), { geometry, distance, duration })

    return {
      from_index: leg.from_index,
      to_index: leg.to_index,
      travel_mode: leg.mode,
      drawn: 'route',
      geometry,
      distance_meters: distance,
      duration_minutes: duration,
    }
  } catch {
    // Timeouts and network failures land here, alongside a malformed response.
    // All of them mean the same thing to the person looking at the map: this
    // leg is a straight line and is labelled as one.
    return straightLine(leg)
  }
}

const MODES: TravelMode[] = ['walking', 'driving']

function isCoordinate(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  )
}

/**
 * A leg the server is willing to route.
 *
 * An unrecognised mode is DROPPED rather than quietly treated as walking. A
 * leg silently routed in the wrong mode is the exact failure this change
 * exists to remove, and defaulting here would reintroduce it one layer down.
 */
function isLeg(value: unknown): value is CrawlRouteRequestLeg {
  if (!value || typeof value !== 'object') return false
  const leg = value as Record<string, unknown>
  return (
    Number.isInteger(leg.from_index) &&
    Number.isInteger(leg.to_index) &&
    isCoordinate(leg.from) &&
    isCoordinate(leg.to) &&
    MODES.includes(leg.mode as TravelMode)
  )
}

export async function POST(request: Request) {
  let body: { legs?: unknown[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const legs = (body.legs ?? []).filter(isLeg)

  // Nothing to draw. Not an error — it is what a crawl with a single stop looks
  // like, and the map asks either way.
  if (legs.length === 0) {
    return NextResponse.json({ segments: [], fallback_count: 0 } satisfies CrawlRoute)
  }

  if (legs.length > MAX_LEGS) {
    return NextResponse.json({ error: 'too_many_legs' }, { status: 400 })
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
  const segments = await Promise.all(legs.map(leg => routeLeg(leg, token)))

  return NextResponse.json({
    segments,
    fallback_count: segments.filter(s => s.drawn === 'straight').length,
  } satisfies CrawlRoute)
}
