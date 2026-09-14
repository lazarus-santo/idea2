import { NextRequest, NextResponse } from 'next/server'
import { getVenueById, runVenueScrapeAttempt } from '@/lib/scraper'
import { claimVenueScrape } from '@/lib/venue-scrape-queue'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import type { AgentRunError } from '@/lib/agent-runs'

// POST /api/admin/venues/[id]/scrape — force-scrape exactly one venue, now.
//
// Ignores the venue's weekly slot, check_back_date and scrape status (including
// error3 — a successful scrape here is one of the two ways out of it; Clear
// Issue is the other). The only thing it respects is the Run Lock: if the
// 15-minute queue already has this venue in progress, it returns 409 instead of
// scraping it a second time, and while this runs the queue skips the venue.
//
// Awaited to completion rather than fired in the background: Vercel freezes the
// instance once the response is sent, so a backgrounded scrape never finishes.
// The admin button waits for the result.

export const maxDuration = 800

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params
  const venue = await getVenueById(id)
  if (!venue) {
    return NextResponse.json({ error: 'Venue not found or inactive' }, { status: 404 })
  }

  const claimed = await claimVenueScrape(venue.id, { mode: 'force', trigger: 'manual', agentRunId: null })
  if (!claimed.ok) {
    const message = claimed.reason === 'not_found'
      ? 'Venue not found'
      : `${venue.name} is already being scraped — try again once that finishes`
    return NextResponse.json({ error: message }, { status: claimed.reason === 'not_found' ? 404 : 409 })
  }

  const errors: AgentRunError[] = []
  const outcome = await runVenueScrapeAttempt(venue, claimed.claim, errors)

  return NextResponse.json({
    venue: venue.name,
    status: outcome.status,
    exhibitions_upserted: outcome.upserted,
    failure_reason: outcome.failureReason,
    duration_ms: outcome.durationMs,
    errors,
  })
}
