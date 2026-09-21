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
 * How you get from one stop to the next.
 *
 * The same two values the /map itinerary's per-leg toggle already uses, and
 * deliberately the same words, because they are the same decision: the line
 * drawn between two stops follows whichever the person picked for that leg.
 * Mapbox calls them routing profiles and names them identically.
 */
export type TravelMode = 'walking' | 'driving'

/**
 * One leg of the drawn route, between consecutive stops.
 *
 * TWO FIELDS RATHER THAN ONE, and the split is the honest part.
 *
 *   travel_mode  what was ASKED FOR — this leg's toggle, walking or driving.
 *   drawn        what came BACK. 'route' means Mapbox returned real directions
 *                for that profile and the geometry below follows actual roads
 *                or pavement. 'straight' means it did not — no route found, no
 *                server token, a timeout, or a stop with no coordinates — and
 *                the leg is a straight line between the two pins instead.
 *
 * They were one overloaded field while every leg was walking, and collapsing
 * them again would lose exactly the thing a mixed route needs to say: WHICH
 * mode had no directions. "No walking directions available" and "no driving
 * directions available" are different facts about different legs, and a person
 * looking at a dashed line deserves to be told which one they are looking at.
 *
 * See app/api/crawl-route/route.ts for why the fallback is per-leg rather than
 * per-route, and why it is labelled on the map rather than hidden.
 */
export interface CrawlRouteSegment {
  /** Index into the stop list, so a segment can be matched to its two ends. */
  from_index: number
  to_index: number
  travel_mode: TravelMode
  drawn: 'route' | 'straight'
  /** [lng, lat] pairs, in Mapbox's order. Two points when drawn is 'straight'. */
  geometry: [number, number][]
  /** Mapbox's numbers, null on a straight-line fallback — there are none to report. */
  distance_meters: number | null
  duration_minutes: number | null
}

/**
 * One leg as the CLIENT asks for it.
 *
 * A list of LEGS rather than a list of points plus a parallel list of modes.
 * Parallel arrays can arrive at different lengths or silently misaligned by
 * one, and a mode attached to the wrong leg would draw a driving route along a
 * leg somebody chose to walk — wrong in a way nothing would flag. A leg that
 * carries its own two ends and its own mode cannot come apart. Same reasoning
 * as set_top_four_content()'s jsonb in migration_v64.
 */
export interface CrawlRouteRequestLeg {
  from_index: number
  to_index: number
  from: [number, number]
  to: [number, number]
  mode: TravelMode
}

/** What /api/crawl-route answers with. */
export interface CrawlRoute {
  segments: CrawlRouteSegment[]
  /**
   * How many legs fell back to a straight line. Zero is the ordinary case; the
   * map says something only when it is not, because a route that is partly
   * guessed should not look identical to one that is not.
   *
   * The count alone is no longer enough to word that message on a mixed route —
   * which modes failed matters — so the map reads that off `segments`. This
   * stays because "is any of this guessed?" is the question asked on every
   * render, and it should not cost a scan.
   */
  fallback_count: number
}
