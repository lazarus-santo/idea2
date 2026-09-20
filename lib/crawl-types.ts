/**
 * The vocabulary of crawls — shared by the server and the browser.
 *
 * Its own file for the reason lib/top-four-types.ts gives: lib/crawls.ts
 * starts with `import 'server-only'`, which is a build-time tripwire, and the
 * builder runs in the browser and needs the constants below. A type imported
 * from a server-only module is erased and harmless; a VALUE imported from one
 * fails the build.
 *
 * ── WHAT A CRAWL IS ────────────────────────────────────────────────────────
 *
 * An ordered list of exhibitions somebody plans to walk between, with the
 * walking route drawn between them. It is a PLAN, which is why nothing here
 * asks whether a stop has been logged — see migration_v66's header for why
 * that differs from the Top Four, which looks structurally identical and is
 * making the opposite kind of claim.
 *
 * ── PHASE 1 ────────────────────────────────────────────────────────────────
 *
 * Building and saving. There is no 'completed' status, no sharing, no like and
 * no connection to exhibition_logs; all of that is Phase 2. Where a type here
 * would obviously grow a field for it, the omission is noted rather than
 * stubbed, because a field nothing writes is a field somebody will later trust.
 */

/**
 * The most stops one crawl can hold.
 *
 * Named because it appears in the UI, in lib/crawl-writes.ts's error wording
 * and in migration_v66 twice — as a CHECK on position and as a named refusal
 * inside set_crawl_stops(). Not an arbitrary round number: every extra stop is
 * one more walking-directions request when the route is drawn, and it is also
 * Mapbox's own waypoint ceiling for a single Directions call.
 */
export const CRAWL_MAX_STOPS = 25

/**
 * draft = still being put together. planned = the owner considers it finished.
 *
 * Phase 2 adds 'completed'. It is absent from the union AND from the database
 * CHECK deliberately: a status the database accepts but nothing can set or act
 * on is a value that will eventually arrive from somewhere and mean nothing.
 *
 * NEITHER STATE AFFECTS WHO MAY SEE THE CRAWL in this phase. Both are
 * owner-only. 'planned' is the owner's note to themselves that they are done
 * fiddling, not a publishing step.
 */
export type CrawlStatus = 'draft' | 'planned'

/** One crawl as its owner sees it in a list. */
export interface Crawl {
  id: string
  title: string
  status: CrawlStatus
  created_at: string
  /** Bumped by renames AND by stop changes — set_crawl_stops() touches the row. */
  updated_at: string
  stop_count: number
}

/**
 * One stop, with everything needed to draw it on the map and label it.
 *
 * `position` is the number shown on the pin, 1-based and gap-free, because
 * set_crawl_stops() generates it from the order of the array it is given and
 * there is no other way to write this table.
 *
 * `venue_name` is the institution's name where there is one ("Gagosian"),
 * falling back to the venue's — the same name the map's pins and popups use,
 * so a stop is labelled with the words somebody would say out loud.
 */
export interface CrawlStopDetail {
  exhibition_id: string
  position: number
  show_title: string
  venue_name: string
  /** Null when nothing could place the show. Such a stop cannot be routed. */
  lat: number | null
  lng: number | null
  end_date: string | null
  image_url: string | null
  /**
   * False when the show has closed since it was added — its end_date has
   * passed. The stop is still returned, still numbered and still removable.
   *
   * Dropping it silently would be worse: the positions of everything after it
   * would shift with no explanation, and a route somebody saved would quietly
   * become a different route. The builder shows it and says so instead.
   */
  on_view: boolean
}

/**
 * One leg of the drawn route, between consecutive stops.
 *
 * `mode` is the honest part. 'walking' means Mapbox returned real pavement
 * directions. 'straight' means it did not — no route found, no server token, a
 * timeout, or a stop with no coordinates — and the leg is drawn as a straight
 * line between the two pins instead. See app/api/crawl-route/route.ts for why
 * the fallback is per-leg rather than per-route, and why it is labelled on the
 * map rather than hidden.
 */
export interface CrawlRouteSegment {
  /** Index into the stop list, so a segment can be matched to its two ends. */
  from_index: number
  to_index: number
  mode: 'walking' | 'straight'
  /** [lng, lat] pairs, in Mapbox's order. Two points when mode is 'straight'. */
  geometry: [number, number][]
  /** Mapbox's numbers, null on a straight-line fallback — there are none to report. */
  distance_meters: number | null
  duration_minutes: number | null
}

/** What /api/crawl-route answers with. */
export interface CrawlRoute {
  segments: CrawlRouteSegment[]
  /**
   * How many legs fell back to a straight line. Zero is the ordinary case; the
   * builder says something only when it is not, because a route that is partly
   * guessed should not look identical to one that is not.
   */
  fallback_count: number
}

/** One exhibition the builder can offer as a stop. */
export interface CrawlCandidate {
  id: string
  title: string
  venue_name: string
  lat: number
  lng: number
  end_date: string | null
}
