import 'server-only'

import { getSupabaseServer } from '@/lib/supabase-server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { resolveExhibitionLocation } from '@/lib/exhibition-location'
import type { CrawlStatus, CrawlStopDetail, CrawlView, TravelMode } from '@/lib/crawl-types'

/**
 * One crawl as this visitor may see it: the crawl, its owner, the visitor's
 * own like and save, and its stops with everything needed to draw and label
 * them.
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
 * THE SESSION CLIENT answers "may you see this crawl". Every read that could
 * leak goes through it, so migration_v66/v67's policies are what refuse — the
 * owner always; anybody can_view_profile() lets through, for a COMPLETED crawl
 * only. There is no visibility rule written out in this file, because a
 * hand-written one is a second privacy model that can drift from the first.
 * (`is_owner` below is compared by hand, but it only chooses which controls
 * the page draws; it grants nothing.)
 *
 * THE ADMIN CLIENT is used for the exhibitions, and only after visibility is
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
export async function getCrawlView(crawlId: string): Promise<CrawlView | null> {
  // A malformed id would come back from PostgREST as a 22P02 error rather than
  // an empty result. Answer it the same way as a missing crawl.
  if (!/^[0-9a-f-]{36}$/i.test(crawlId)) return null

  const supabase = await getSupabaseServer()
  const viewer = await getCurrentUser()

  // Visibility, decided by RLS. "No such crawl", "somebody's draft" and "a
  // profile you may not see" are the same answer on purpose: telling them
  // apart would confirm that an id names a real crawl belonging to someone.
  //
  // The owner's profile is embedded under the same session. Anybody who can
  // see a completed crawl can see its owner's profile — the crawl's policy IS
  // can_view_profile() — so this cannot return a name the profile would hide.
  //
  // The embed NAMES its foreign key. crawl_likes and crawl_saves (v67) each
  // join a crawl to a profile too, so PostgREST sees three routes from crawls
  // to profiles and refuses a bare `profiles(...)` as ambiguous — which would
  // make every crawl fail to open.
  const { data: crawlRow, error: crawlError } = await supabase
    .from('crawls')
    .select('id, user_id, title, status, completed_at, profiles!crawls_user_id_fkey(username, display_name)')
    .eq('id', crawlId)
    .maybeSingle()

  if (crawlError) {
    console.error('[crawl-stops] crawl lookup failed:', crawlError.message)
    return null
  }
  if (!crawlRow) return null

  const crawl = crawlRow as unknown as {
    id: string
    user_id: string
    title: string
    status: CrawlStatus
    completed_at: string | null
    profiles: { username: string | null; display_name: string | null } | null
  }
  const isOwner = viewer?.id === crawl.user_id
  const completed = crawl.status === 'completed'

  // The like count, and the viewer's own like and save. Only a completed crawl
  // has any of them. The two first-person reads return the viewer's own rows
  // and nothing else, whatever is asked (RLS); the count asks
  // can_view_profile() itself.
  let likeCount: number | null = null
  let liked = false
  let saved = false
  if (completed) {
    const [countRes, likeRes, saveRes] = await Promise.all([
      supabase.rpc('crawl_like_counts', { p_crawl_ids: [crawl.id] }),
      viewer && !isOwner
        ? supabase.from('crawl_likes').select('crawl_id').eq('crawl_id', crawl.id).eq('user_id', viewer.id)
        : Promise.resolve({ data: [], error: null }),
      viewer && !isOwner
        ? supabase.from('crawl_saves').select('crawl_id').eq('crawl_id', crawl.id).eq('user_id', viewer.id)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (countRes.error) console.error('[crawl-stops] like count failed:', countRes.error.message)
    likeCount = ((countRes.data ?? []) as { like_count: number }[])[0]?.like_count ?? 0
    liked = (likeRes.data ?? []).length > 0
    saved = (saveRes.data ?? []).length > 0
  }

  const meta: CrawlView['crawl'] = {
    id: crawl.id,
    title: crawl.title,
    status: crawl.status,
    completed_at: crawl.completed_at,
    is_owner: isOwner,
    owner_username: crawl.profiles?.username ?? null,
    owner_display_name: crawl.profiles?.display_name ?? null,
    like_count: likeCount,
    liked,
    saved,
  }

  // Also under the session: crawl_stops' select policies ask the same question
  // of the same crawl, so this cannot return rows the check above would refuse.
  const { data: stopRows, error: stopsError } = await supabase
    .from('crawl_stops')
    .select('exhibition_id, position, arrive_by')
    .eq('crawl_id', crawlId)
    .order('position', { ascending: true })

  if (stopsError) {
    console.error('[crawl-stops] stop lookup failed:', stopsError.message)
    return null
  }

  const stops = (stopRows ?? []) as {
    exhibition_id: string
    position: number
    arrive_by: TravelMode | null
  }[]
  if (stops.length === 0) return { crawl: meta, stops: [] }

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

  const details: CrawlStopDetail[] = stops.map((stop) => {
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
        arrive_by: stop.arrive_by,
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
      arrive_by: stop.arrive_by,
    }
  })

  return { crawl: meta, stops: details }
}
