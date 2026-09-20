import 'server-only'

import { getSupabaseServer } from '@/lib/supabase-server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { resolveExhibitionLocation } from '@/lib/exhibition-location'
import type { CrawlStopDetail } from '@/lib/crawl-types'

/**
 * One crawl's stops, with everything needed to draw and label them.
 *
 * ── WHY THIS IS NOT A DATABASE FUNCTION ────────────────────────────────────
 *
 * The obvious shape, following migration_v62's profile_exhibition_logs(), is a
 * SECURITY DEFINER function that joins crawl_stops to exhibitions in SQL. It
 * would be needed if a browser had to make this read: migration_v26 granted
 * published exhibitions to `anon` only, so `authenticated` has NO read policy
 * on that table and a signed-in person cannot select a show title through
 * their own session.
 *
 * It is not used, for one reason: WHERE A SHOW IS is not a column. It is the
 * priority in lib/exhibition-location.ts — an admin's address_override beats
 * Agent 1's show_location beats the venue's own address, with coordinates
 * falling through the same order independently of the address. That logic
 * exists, is used by the map, the exhibition page and "nearby", and writing it
 * a second time in PL/pgSQL would mean a crawl could eventually place a show
 * somewhere the rest of the site does not.
 *
 * So the read is composed here, on the server, where that function already
 * lives. This runs in a Server Component, never in a browser, which is what
 * makes the arrangement below safe.
 *
 * ── THE TWO CLIENTS, AND WHICH ONE DECIDES ANYTHING ────────────────────────
 *
 * THE SESSION CLIENT answers "is this your crawl". Both reads that could leak
 * go through it, so migration_v66's policies are what refuse — there is no
 * ownership comparison written out in this file, because a hand-written one is
 * a second privacy model that can drift from the first.
 *
 * THE ADMIN CLIENT is used for the exhibitions, and only after ownership is
 * settled. What it reads is public: every field below is already on the show's
 * own page and on the map for signed-out visitors. It is the GRANT that is
 * missing for `authenticated`, not the secrecy.
 *
 * ── A CLOSED SHOW IS STILL A STOP ──────────────────────────────────────────
 *
 * Stops whose show has ended come back with on_view false rather than being
 * dropped. Dropping them would renumber everything after them with no
 * explanation and quietly turn a route somebody saved into a different route.
 * The builder draws them muted, says they have closed, and lets them be removed.
 */
export async function getCrawlStopDetails(crawlId: string): Promise<CrawlStopDetail[] | null> {
  const supabase = await getSupabaseServer()

  // Ownership, decided by RLS. "No such crawl" and "not yours" are the same
  // answer on purpose: telling them apart would confirm that an id names a
  // real crawl belonging to someone.
  const { data: crawl, error: crawlError } = await supabase
    .from('crawls')
    .select('id')
    .eq('id', crawlId)
    .maybeSingle()

  if (crawlError) {
    console.error('[crawl-stops] crawl lookup failed:', crawlError.message)
    return null
  }
  if (!crawl) return null

  // Also under the session: crawl_stops' select policy asks the same question
  // of the same table, so this cannot return rows the check above would refuse.
  const { data: stopRows, error: stopsError } = await supabase
    .from('crawl_stops')
    .select('exhibition_id, position')
    .eq('crawl_id', crawlId)
    .order('position', { ascending: true })

  if (stopsError) {
    console.error('[crawl-stops] stop lookup failed:', stopsError.message)
    return null
  }

  const stops = (stopRows ?? []) as { exhibition_id: string; position: number }[]
  if (stops.length === 0) return []

  const { data: shows, error: showsError } = await getSupabaseAdmin()
    .from('exhibitions')
    .select(`
      id,
      show_title,
      end_date,
      is_ongoing,
      image_url,
      address_override,
      address_override_neighborhood,
      override_latitude,
      override_longitude,
      show_location,
      show_location_2,
      show_location_3,
      show_location_neighborhood,
      show_location_latitude,
      show_location_longitude,
      venues!inner(id, name, latitude, longitude, address, neighborhood,
        institutions(id, name)
      )
    `)
    .in('id', stops.map((s) => s.exhibition_id))
    // Belt and braces with the trigger that refused the write in the first
    // place. A show unpublished AFTER it was added must not come back with a
    // title from behind the editorial gate; it drops out of the map below and
    // is reported as a stop that can no longer be placed.
    .eq('status', 'published')

  if (showsError) {
    console.error('[crawl-stops] exhibition lookup failed:', showsError.message)
    return null
  }

  const today = new Date().toISOString().split('T')[0]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId = new Map<string, any>(((shows ?? []) as any[]).map((s) => [s.id, s]))

  return stops.map((stop) => {
    const show = byId.get(stop.exhibition_id)

    if (!show) {
      return {
        exhibition_id: stop.exhibition_id,
        position: stop.position,
        show_title: 'This show is no longer listed',
        venue_name: '',
        lat: null,
        lng: null,
        end_date: null,
        image_url: null,
        on_view: false,
      }
    }

    const venue = show.venues
    const location = resolveExhibitionLocation(show, venue)

    return {
      exhibition_id: show.id,
      position: stop.position,
      show_title: show.show_title,
      // The institution's name where there is one ("Gagosian"), the venue's
      // otherwise — the same name the map's pins carry, so a stop is labelled
      // with the words somebody would actually say.
      venue_name: venue?.institutions?.name ?? venue?.name ?? '',
      lat: location.lat,
      lng: location.lng,
      end_date: show.end_date ?? null,
      image_url: show.image_url ?? null,
      on_view: Boolean(show.is_ongoing) || !show.end_date || show.end_date >= today,
    }
  })
}
