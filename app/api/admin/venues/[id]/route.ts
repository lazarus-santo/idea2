import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// PATCH /api/admin/venues/[id] — update scrape flags
// Body: {
//   manual_entry_required?: boolean, scrape_failed?: boolean,
//   scrape_failure_reason?: string,
//   scrape_notes?: string | null,   free-text hint fed to the extraction prompt
//   scrapable?: boolean             human decision to stop scraping this venue
// }
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

  return NextResponse.json({ ok: true })
}
