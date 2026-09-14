import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { resetVenueScrapeState } from '@/lib/venue-scrape-queue'

// PATCH /api/admin/venues/[id] — update scrape flags
// Body: {
//   manual_entry_required?: boolean, scrape_failed?: boolean,
//   scrape_failure_reason?: string,
//   scrape_notes?: string | null,   free-text hint fed to the extraction prompt
//   scrapable?: boolean             human decision to stop scraping this venue
// }
//
// Setting manual_entry_required to false also resets the venue's queue state to
// not_started with no failures. That is the Scrape Issues "Clear Issue" button,
// and it is the way out of error3 without scraping: clearing the flag alone
// would leave error3 blocking the queue.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params
  const body = await request.json() as Record<string, unknown>

  const allowed = ['manual_entry_required', 'scrape_failed', 'scrape_failure_reason', 'scrape_notes', 'scrapable']
  const update: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) update[key] = body[key]
  }

  // The note goes into a model prompt, so an empty textarea must become NULL
  // rather than an empty string that renders as a blank "note from the operator"
  // heading with nothing under it.
  if ('scrape_notes' in update) {
    const n = update.scrape_notes
    update.scrape_notes = typeof n === 'string' && n.trim() ? n.trim() : null
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const { error } = await getSupabaseAdmin()
    .from('venues')
    .update(update)
    .eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (update.manual_entry_required === false) {
    // 'in_progress' means a scrape is running right now; its own result will
    // set the status when it finishes.
    const scrapeState = await resetVenueScrapeState(id)
    return NextResponse.json({ ok: true, scrape_state: scrapeState })
  }

  return NextResponse.json({ ok: true })
}
