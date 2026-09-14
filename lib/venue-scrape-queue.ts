import { getSupabaseAdmin } from './supabase'
import {
  decideQueueEligibility,
  failureStatus,
  isStaleClaim,
  MAX_SCRAPE_FAILURES,
  type AttemptHistoryRow,
  type ScrapeStatus,
  type VenueScrapeState,
} from './venue-scrape-schedule'

// Database side of Agent 1's venue queue (rules live in venue-scrape-schedule.ts).
//
// Every venue state change is a compare-and-swap on scrape_status_version: read
// the row, decide, then update only where the version is still the one that was
// read. Postgres re-evaluates that condition under the row lock, so when two
// writers race, exactly one update matches and the other gets zero rows back.
// This is the Run Lock. It holds the same way between two cron invocations and
// between the cron and the admin's single-venue trigger.

export type ScrapeTrigger = 'cron' | 'manual'

const STATE_SELECT =
  'id, scrape_day_of_week, check_back_date, scrape_status, scrape_status_changed_at, scrape_failures, scrape_status_version'

interface VenueStateRow extends VenueScrapeState {
  id: string
  scrape_status_version: number
}

export interface ScrapeClaim {
  venueId: string
  /** The version the claim wrote; completion only applies if it still matches. */
  version: number
  previousFailures: number
  attemptId: string | null
  startedAtMs: number
}

export type ClaimResult =
  | { ok: true; claim: ScrapeClaim }
  | { ok: false; reason: 'not_found' | 'not_eligible' | 'in_progress' | 'lost_race'; detail?: string }

export interface VenueScrapeOutcome {
  /** Null when the venue's state changed underneath the scrape and was left alone. */
  status: ScrapeStatus | null
  durationMs: number
  upserted: number
  failureReason: string | null
}

async function readState(venueId: string): Promise<VenueStateRow | null> {
  const { data } = await getSupabaseAdmin().from('venues').select(STATE_SELECT).eq('id', venueId).maybeSingle()
  return (data as VenueStateRow | null) ?? null
}

async function casUpdate(venueId: string, expectedVersion: number, fields: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from('venues')
    .update({ ...fields, scrape_status_version: expectedVersion + 1 })
    .eq('id', venueId)
    .eq('scrape_status_version', expectedVersion)
    .select('id')

  if (error) {
    console.error(`[scrape-state] Update failed for venue ${venueId}:`, error.message)
    return false
  }
  return (data ?? []).length === 1
}

function failureFields(previousFailures: number, reason: string, at: Date) {
  const next = failureStatus(previousFailures)
  return {
    next,
    fields: {
      scrape_status: next.status,
      scrape_failures: next.failures,
      scrape_status_changed_at: at.toISOString(),
      scrape_failed: true,
      scrape_failure_reason: reason,
      // error3 is the hard wall. manual_entry_required is what already takes a
      // venue out of every queue query and puts it on the Scrape Issues tab.
      ...(next.failures >= MAX_SCRAPE_FAILURES ? { manual_entry_required: true } : {}),
    },
  }
}

// An in_progress claim past SCRAPE_STALE_MS belongs to a killed invocation. It
// counts as that attempt's failure, so it takes the normal cooldown instead of
// being re-scraped straight away.
async function recoverStaleClaim(row: VenueStateRow, now: Date): Promise<boolean> {
  const { next, fields } = failureFields(row.scrape_failures, 'timed_out', now)
  const won = await casUpdate(row.id, row.scrape_status_version, fields)
  if (!won) return false

  const { error } = await getSupabaseAdmin()
    .from('venue_scrape_attempts')
    .update({ outcome: 'timed_out', failure_reason: 'timed_out' })
    .eq('venue_id', row.id)
    .eq('outcome', 'running')
  if (error) console.error(`[scrape-state] Could not mark attempt timed_out for venue ${row.id}:`, error.message)

  console.warn(`[scrape-state] Venue ${row.id} was stuck in_progress since ${row.scrape_status_changed_at} — now ${next.status}`)
  return true
}

export async function sweepStaleClaims(now = new Date()): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from('venues')
    .select(STATE_SELECT)
    .eq('scrape_status', 'in_progress')
  if (error) {
    console.error('[scrape-state] Stale sweep query failed:', error.message)
    return 0
  }

  let recovered = 0
  for (const row of (data ?? []) as VenueStateRow[]) {
    if (isStaleClaim(row, now) && (await recoverStaleClaim(row, now))) recovered++
  }
  return recovered
}

/**
 * Marks a venue in_progress, the moment before any work starts.
 *
 * mode 'queue' re-checks eligibility against a fresh read, since the queue list
 * may be minutes old by the time a venue's turn comes. mode 'force' (the admin
 * trigger) skips the day, check-back and status gates — everything except a
 * live claim by someone else.
 */
export async function claimVenueScrape(
  venueId: string,
  opts: { mode: 'queue' | 'force'; trigger: ScrapeTrigger; agentRunId: string | null }
): Promise<ClaimResult> {
  const now = new Date()
  let row = await readState(venueId)
  if (!row) return { ok: false, reason: 'not_found' }

  if (isStaleClaim(row, now)) {
    await recoverStaleClaim(row, now)
    row = await readState(venueId)
    if (!row) return { ok: false, reason: 'not_found' }
  }

  if (row.scrape_status === 'in_progress') return { ok: false, reason: 'in_progress' }

  if (opts.mode === 'queue') {
    const decision = decideQueueEligibility(row, now)
    if (!decision.eligible) return { ok: false, reason: 'not_eligible', detail: decision.reason }
  }

  const won = await casUpdate(row.id, row.scrape_status_version, {
    scrape_status: 'in_progress',
    scrape_status_changed_at: now.toISOString(),
  })
  if (!won) return { ok: false, reason: 'lost_race' }

  // Bookkeeping must not block the scrape: a failed insert only loses this
  // attempt's timing, so the claim still stands.
  const { data: attempt, error } = await getSupabaseAdmin()
    .from('venue_scrape_attempts')
    .insert({ venue_id: row.id, agent_run_id: opts.agentRunId, trigger: opts.trigger, started_at: now.toISOString() })
    .select('id')
    .single()
  if (error) console.error(`[scrape-state] Could not record attempt for venue ${row.id}:`, error.message)

  return {
    ok: true,
    claim: {
      venueId: row.id,
      version: row.scrape_status_version + 1,
      previousFailures: row.scrape_failures,
      attemptId: (attempt?.id as string | undefined) ?? null,
      startedAtMs: now.getTime(),
    },
  }
}

/** Records the attempt's duration and moves the venue to completed or errorN. */
export async function finishVenueScrape(
  claim: ScrapeClaim,
  result: { upserted: number; failureReason: string | null }
): Promise<VenueScrapeOutcome> {
  const completedAt = new Date()
  const durationMs = completedAt.getTime() - claim.startedAtMs
  const failed = result.failureReason !== null

  if (claim.attemptId) {
    const { error } = await getSupabaseAdmin()
      .from('venue_scrape_attempts')
      .update({
        completed_at: completedAt.toISOString(),
        duration_ms: durationMs,
        outcome: failed ? 'failed' : 'completed',
        failure_reason: result.failureReason,
        exhibitions_upserted: result.upserted,
      })
      .eq('id', claim.attemptId)
    if (error) console.error(`[scrape-state] Could not complete attempt ${claim.attemptId}:`, error.message)
  }

  let status: ScrapeStatus
  let fields: Record<string, unknown>
  if (failed) {
    const failure = failureFields(claim.previousFailures, result.failureReason as string, completedAt)
    status = failure.next.status
    fields = failure.fields
  } else {
    status = 'completed'
    fields = { scrape_status: 'completed', scrape_failures: 0, scrape_status_changed_at: completedAt.toISOString() }
  }

  const won = await casUpdate(claim.venueId, claim.version, fields)
  if (!won) {
    console.warn(`[scrape-state] Venue ${claim.venueId} changed while it was being scraped — leaving its state as found`)
  }

  return { status: won ? status : null, durationMs, upserted: result.upserted, failureReason: result.failureReason }
}

/**
 * Back to not_started with no failures — the admin's way out of error3. Refuses
 * a venue that is actually mid-scrape, since resetting it would let the queue
 * claim it a second time.
 */
export async function resetVenueScrapeState(venueId: string): Promise<'reset' | 'in_progress' | 'not_found'> {
  const now = new Date()
  let row = await readState(venueId)
  if (!row) return 'not_found'

  if (isStaleClaim(row, now)) {
    await recoverStaleClaim(row, now)
    row = await readState(venueId)
    if (!row) return 'not_found'
  }
  if (row.scrape_status === 'in_progress') return 'in_progress'
  if (row.scrape_status === 'not_started' && row.scrape_failures === 0) return 'reset'

  const won = await casUpdate(row.id, row.scrape_status_version, {
    scrape_status: 'not_started',
    scrape_failures: 0,
    scrape_status_changed_at: now.toISOString(),
  })
  // Losing the swap here means a claim landed between the read and the write.
  return won ? 'reset' : 'in_progress'
}

/** Newest-first finished attempts per venue, for estimateVenueScrapeMs. */
export async function loadAttemptHistory(venueIds: string[]): Promise<Map<string, AttemptHistoryRow[]>> {
  const history = new Map<string, AttemptHistoryRow[]>()
  if (venueIds.length === 0) return history

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await getSupabaseAdmin()
    .from('venue_scrape_attempts')
    .select('venue_id, outcome, duration_ms')
    .in('venue_id', venueIds)
    .neq('outcome', 'running')
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(1000)

  if (error) {
    // Every venue falls back to the default estimate — slower, never unsafe.
    console.error('[scrape-state] Attempt history query failed:', error.message)
    return history
  }

  for (const row of data ?? []) {
    const list = history.get(row.venue_id as string) ?? []
    list.push({ outcome: row.outcome as AttemptHistoryRow['outcome'], duration_ms: row.duration_ms as number | null })
    history.set(row.venue_id as string, list)
  }
  return history
}
