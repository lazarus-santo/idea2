// Per-venue health for the admin dashboard: what each venue is producing, where
// its shows are dying, and when it was last and next scraped.
//
// The signal this exists for is consecutive_zero_scrapes. A venue that quietly
// returns nothing looks identical to a venue with nothing on — until you can see
// that it has returned nothing three times in a row. A steady 0 or 1 is normal for
// a small gallery between shows; a count that has just started climbing is the
// thing worth opening.

import { getSupabaseAdmin } from './supabase'
import { nextScheduledScrapeDate, nyCalendar, type ScrapeStatus } from './venue-scrape-schedule'

export interface VenueHealth {
  id: string
  name: string
  exhibitions_url: string
  type: string
  published_count: number
  pending_count: number
  /** Most common failure/discard outcome recorded against this venue's shows. */
  top_discard_stage: string | null
  top_discard_count: number
  last_scrape_at: string | null
  /** null when the venue has no weekly slot, so nothing would ever queue it. */
  next_scrape_due: string | null
  consecutive_zero_scrapes: number
  /** How many finished attempts are on record — 0 means the streak above is not
   *  yet meaningful rather than healthy. */
  attempts_recorded: number
  scrape_status: ScrapeStatus
  scrape_failures: number
  manual_entry_required: boolean
  scrapable: boolean
  scrape_day_of_week: number | null
}

// Outcomes in agent1_fetch_logs that mean a show did not make it. Everything else
// recorded there ("inserted:…", "updated:…", "skipped_published:…") is a success.
const DISCARD_PREFIXES = [
  'temporal_discarded', 'extraction_failed', 'fetch_failed', 'hallucination_rejected',
  'upsert_failed', 'location_rejected', 'no_date_evidence',
]

function isDiscardOutcome(outcome: string): boolean {
  return DISCARD_PREFIXES.some((p) => outcome.startsWith(p))
}

/**
 * Leading run of finished scrapes that produced nothing, newest first.
 *
 * Only completed attempts count either way: a failed or timed-out attempt is
 * already visible as an error on the Scrape Issues tab, and treating it as a zero
 * would double-report the same problem here. Such attempts neither extend nor
 * reset the streak — they are skipped, so a failure in the middle doesn't hide a
 * genuine run of empty scrapes on either side of it.
 */
export function consecutiveZeroScrapes(
  attempts: { outcome: string; exhibitions_upserted: number | null }[]
): number {
  let streak = 0
  for (const attempt of attempts) {
    if (attempt.outcome !== 'completed') continue
    if ((attempt.exhibitions_upserted ?? 0) > 0) break
    streak++
  }
  return streak
}

export async function getVenueHealth(now = new Date()): Promise<VenueHealth[]> {
  const db = getSupabaseAdmin()

  const [venuesRes, exhibitionsRes, attemptsRes, logsRes] = await Promise.all([
    db
      .from('venues')
      .select('id, name, exhibitions_url, check_back_date, scrape_status, scrape_failures, manual_entry_required, scrapable, scrape_day_of_week, scrape_status_changed_at, institutions!inner(type)')
      .eq('active', true)
      .order('name'),
    db.from('exhibitions').select('venue_id, status'),
    db
      .from('venue_scrape_attempts')
      .select('venue_id, started_at, outcome, exhibitions_upserted')
      .order('started_at', { ascending: false })
      .limit(2000),
    // Recent only: a venue's failure mode from six months ago is not today's.
    db
      .from('agent1_fetch_logs')
      .select('venue_id, outcome, created_at')
      .order('created_at', { ascending: false })
      .limit(4000),
  ])

  if (venuesRes.error) throw new Error(`Venue health query failed: ${venuesRes.error.message}`)

  const published = new Map<string, number>()
  const pending = new Map<string, number>()
  for (const row of exhibitionsRes.data ?? []) {
    const target = row.status === 'published' ? published : row.status === 'pending' ? pending : null
    if (!target) continue
    const id = row.venue_id as string
    target.set(id, (target.get(id) ?? 0) + 1)
  }

  const attemptsByVenue = new Map<string, { outcome: string; exhibitions_upserted: number | null; started_at: string }[]>()
  for (const row of attemptsRes.data ?? []) {
    const id = row.venue_id as string
    const list = attemptsByVenue.get(id) ?? []
    list.push({
      outcome: row.outcome as string,
      exhibitions_upserted: row.exhibitions_upserted as number | null,
      started_at: row.started_at as string,
    })
    attemptsByVenue.set(id, list)
  }

  const discardsByVenue = new Map<string, Map<string, number>>()
  for (const row of logsRes.data ?? []) {
    const outcome = (row.outcome as string) ?? ''
    if (!isDiscardOutcome(outcome)) continue
    const id = row.venue_id as string
    if (!id) continue
    // "location_rejected:Palm Beach" and "location_rejected:Claverack" are the same
    // stage; the city belongs in the log, not in a count of where shows die.
    const stage = outcome.split(':')[0]
    const counts = discardsByVenue.get(id) ?? new Map<string, number>()
    counts.set(stage, (counts.get(stage) ?? 0) + 1)
    discardsByVenue.set(id, counts)
  }

  const today = nyCalendar(now).date

  return (venuesRes.data ?? []).map((v) => {
    const id = v.id as string
    const attempts = attemptsByVenue.get(id) ?? []
    const finished = attempts.filter((a) => a.outcome !== 'running')

    const discardCounts = discardsByVenue.get(id)
    let topStage: string | null = null
    let topCount = 0
    for (const [stage, count] of discardCounts ?? []) {
      if (count > topCount) { topStage = stage; topCount = count }
    }

    const checkBack = v.check_back_date as string | null
    const dayOfWeek = v.scrape_day_of_week as number | null
    // A check_back_date still in the future is what actually holds the venue back;
    // otherwise it comes due on its weekly slot.
    const nextDue = dayOfWeek === null
      ? null
      : checkBack && checkBack > today
        ? checkBack
        : nextScheduledScrapeDate(dayOfWeek, now)

    return {
      id,
      name: v.name as string,
      exhibitions_url: v.exhibitions_url as string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: ((v.institutions as any)?.type ?? 'gallery') as string,
      published_count: published.get(id) ?? 0,
      pending_count: pending.get(id) ?? 0,
      top_discard_stage: topStage,
      top_discard_count: topCount,
      last_scrape_at: attempts[0]?.started_at ?? (v.scrape_status_changed_at as string | null) ?? null,
      next_scrape_due: nextDue,
      consecutive_zero_scrapes: consecutiveZeroScrapes(finished),
      attempts_recorded: finished.length,
      scrape_status: (v.scrape_status as ScrapeStatus | null) ?? 'not_started',
      scrape_failures: (v.scrape_failures as number | null) ?? 0,
      manual_entry_required: (v.manual_entry_required as boolean | null) ?? false,
      scrapable: (v.scrapable as boolean | null) ?? true,
      scrape_day_of_week: dayOfWeek,
    }
  })
}
