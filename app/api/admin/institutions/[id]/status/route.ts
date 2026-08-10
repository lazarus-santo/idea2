import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// PATCH /api/admin/institutions/[id]/status
// Body: { status: 'active' | 'closed' | 'not_relevant', status_note?: string }
//
// status records WHY an institution is out; venues.active is WHAT actually stops
// the scraper. Nothing in the codebase filters on institutions.active — the
// scrape queue reads venues — so setting the status has to cascade to the venue
// rows or a shut-down gallery would keep getting scraped every week.
//
// Reversible: setting the status back to 'active' reactivates the same venues.
// The cascade is deliberately blunt, so a venue deactivated on its own for some
// unrelated reason will come back too if its institution is reopened. That is
// worth knowing, and preferable to leaving a reopened gallery half-off with no
// indication of which half.

const STATUSES = ['active', 'closed', 'not_relevant'] as const
type Status = (typeof STATUSES)[number]

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params
  const body = await request.json().catch(() => ({})) as Record<string, unknown>

  const status = body.status as Status
  if (!STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of ${STATUSES.join(', ')}` },
      { status: 400 }
    )
  }

  const note = typeof body.status_note === 'string' && body.status_note.trim()
    ? body.status_note.trim()
    : null

  const db = getSupabaseAdmin()
  const isActive = status === 'active'

  const { data: inst, error: instErr } = await db
    .from('institutions')
    .update({ status, status_note: note, active: isActive })
    .eq('id', id)
    .select('id, name')
    .maybeSingle()

  if (instErr) return NextResponse.json({ error: instErr.message }, { status: 500 })
  if (!inst) return NextResponse.json({ error: 'Institution not found' }, { status: 404 })

  const { data: venues, error: venueErr } = await db
    .from('venues')
    .update({ active: isActive })
    .eq('institution_id', id)
    .select('id')

  if (venueErr) {
    // The institution is already updated at this point. Report the partial
    // result rather than a bare 500 — otherwise it looks like nothing happened
    // while the gallery is in fact half-marked.
    return NextResponse.json(
      { error: `Institution updated but venues were not: ${venueErr.message}`, status },
      { status: 500 }
    )
  }

  return NextResponse.json({
    ok: true,
    id: inst.id,
    name: inst.name,
    status,
    status_note: note,
    venues_updated: (venues ?? []).length,
  })
}
