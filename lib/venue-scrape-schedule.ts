// Pure scheduling rules for Agent 1's venue queue — no I/O, so the admin UI can
// import the constants and the rules can be exercised without a database.
// The database side (claims, completion, stale recovery) is venue-scrape-queue.ts.

export type ScrapeStatus = 'not_started' | 'in_progress' | 'completed' | 'error1' | 'error2' | 'error3'

// Day-of-week slots and "today" are New York calendar days. The cron fires in
// UTC, and a UTC day would split an evening NY scrape onto the next weekday.
export const SCRAPE_TIME_ZONE = 'America/New_York'

export const MAX_SCRAPE_FAILURES = 3

// A claim older than this is a scrape whose function was killed. Mirrors
// LOCK_STALE_MS in app/api/cron/scrape: the 800s function ceiling plus 60s. No
// real scrape can outlive the invocation running it, so anything past this is dead.
export const SCRAPE_STALE_MS = 800_000 + 60_000

// Wait between automatic retries after error1/error2. Long enough that a retry
// samples a different part of the day (overnight maintenance, rate limits that
// reset over hours), short enough that all three attempts land within a day.
export const ERROR_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000

// Estimate for a venue with no completed attempt on record. Above the slowest
// single-venue slice observed (581s on 2026-09-01, which also included post-loop
// preread repair), so an unknown venue only starts with a nearly fresh invocation.
export const DEFAULT_VENUE_SCRAPE_MS = 600_000

// Venue durations swing run to run (Browserbase retries, detail-page counts);
// an underestimate gets the scrape killed and counted as a failure.
export const SCRAPE_ESTIMATE_HEADROOM = 1.25
export const SCRAPE_HISTORY_SIZE = 5

export interface VenueScrapeState {
  scrape_day_of_week: number | null
  check_back_date: string | null
  scrape_status: ScrapeStatus
  scrape_status_changed_at: string | null
  scrape_failures: number
}

export type QueueDecision =
  | { eligible: true; reason: 'scheduled' | 'retry' }
  | {
      eligible: false
      reason:
        | 'no_day_assigned'
        | 'not_scheduled_today'
        | 'check_back_pending'
        | 'completed_today'
        | 'in_progress'
        | 'stale_in_progress'
        | 'cooling_down'
        | 'error3'
    }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function nyCalendar(at: Date): { date: string; dayOfWeek: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCRAPE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(at)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    dayOfWeek: WEEKDAYS.indexOf(part('weekday')),
  }
}

// The venue's next slot strictly after today, so a scrape on the scheduled day
// comes due again exactly a week later, and a retry or manual scrape on another
// day doesn't push the venue past its next slot. Venues with no slot fall back
// to a week out.
export function nextScheduledScrapeDate(dayOfWeek: number | null, now: Date): string {
  const today = nyCalendar(now)
  const daysAhead = dayOfWeek === null ? 7 : ((dayOfWeek - today.dayOfWeek + 7) % 7) || 7
  const d = new Date(`${today.date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + daysAhead)
  return d.toISOString().slice(0, 10)
}

export function isStaleClaim(state: Pick<VenueScrapeState, 'scrape_status' | 'scrape_status_changed_at'>, now: Date): boolean {
  if (state.scrape_status !== 'in_progress') return false
  // A claim with no timestamp can't be dated, so it can never be proven live.
  if (!state.scrape_status_changed_at) return true
  return now.getTime() - Date.parse(state.scrape_status_changed_at) > SCRAPE_STALE_MS
}

export function decideQueueEligibility(state: VenueScrapeState, now: Date): QueueDecision {
  const today = nyCalendar(now)
  const checkBackPending = state.check_back_date !== null && state.check_back_date > today.date
  const changedAt = state.scrape_status_changed_at ? Date.parse(state.scrape_status_changed_at) : null

  switch (state.scrape_status) {
    case 'in_progress':
      return { eligible: false, reason: isStaleClaim(state, now) ? 'stale_in_progress' : 'in_progress' }

    case 'error3':
      return { eligible: false, reason: 'error3' }

    case 'error1':
    case 'error2':
      // Retries ignore the weekly slot but not check_back_date.
      if (changedAt !== null && now.getTime() - changedAt < ERROR_RETRY_COOLDOWN_MS) {
        return { eligible: false, reason: 'cooling_down' }
      }
      if (checkBackPending) return { eligible: false, reason: 'check_back_pending' }
      return { eligible: true, reason: 'retry' }

    case 'completed':
      if (changedAt !== null && nyCalendar(new Date(changedAt)).date === today.date) {
        return { eligible: false, reason: 'completed_today' }
      }
    // A completion from an earlier day is today's not_started.
    // falls through
    case 'not_started':
    default:
      if (state.scrape_day_of_week === null) return { eligible: false, reason: 'no_day_assigned' }
      if (state.scrape_day_of_week !== today.dayOfWeek) return { eligible: false, reason: 'not_scheduled_today' }
      if (checkBackPending) return { eligible: false, reason: 'check_back_pending' }
      return { eligible: true, reason: 'scheduled' }
  }
}

export function failureStatus(previousFailures: number): { status: ScrapeStatus; failures: number } {
  const failures = Math.min(previousFailures + 1, MAX_SCRAPE_FAILURES)
  return { status: `error${failures}` as ScrapeStatus, failures }
}

export interface AttemptHistoryRow {
  outcome: 'running' | 'completed' | 'failed' | 'timed_out'
  duration_ms: number | null
}

// History newest-first. Failed attempts are left out of the average: most
// failures end at the listing page in seconds and would drag the estimate
// below what a real scrape of the same venue takes.
export function estimateVenueScrapeMs(history: AttemptHistoryRow[]): {
  estimateMs: number
  basis: 'default' | 'history' | 'recent_timeout'
} {
  const recent = history.filter((a) => a.outcome !== 'running').slice(0, SCRAPE_HISTORY_SIZE)
  const durations = recent
    .filter((a) => a.outcome === 'completed' && a.duration_ms !== null)
    .map((a) => a.duration_ms as number)

  if (durations.length === 0) return { estimateMs: DEFAULT_VENUE_SCRAPE_MS, basis: 'default' }

  const average = durations.reduce((sum, ms) => sum + ms, 0) / durations.length
  const estimateMs = Math.round(average * SCRAPE_ESTIMATE_HEADROOM)

  // A recent kill means the completed average undersells this venue.
  if (recent.some((a) => a.outcome === 'timed_out')) {
    return { estimateMs: Math.max(estimateMs, DEFAULT_VENUE_SCRAPE_MS), basis: 'recent_timeout' }
  }
  return { estimateMs, basis: 'history' }
}

// The first venue of an invocation always starts: it has the whole budget, and
// refusing it would leave a venue slower than the budget blocking the head of
// the queue forever instead of failing its way to error3 and Scrape Issues.
export function hasTimeFor(elapsedMs: number, estimateMs: number, budgetMs: number, isFirstVenue: boolean): boolean {
  return isFirstVenue || elapsedMs + estimateMs <= budgetMs
}
