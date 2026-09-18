import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { setPrereadRowStatus, Agent2UserError } from '@/lib/agent2'
import { ROW_STATUSES, type RowStatus } from '@/lib/types'

// PATCH /api/admin/prereads/[id] — the admin Blank / Activate buttons (Trigger 3C).
// Body: { row_status: 'active' | 'blanked' }. A manual override: it changes only
// whether the row shows publicly, never its quality_flag or the show's status.
export async function PATCH(request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const rowStatus = body?.row_status as RowStatus
  if (!ROW_STATUSES.includes(rowStatus)) {
    return NextResponse.json({ error: `row_status must be one of: ${ROW_STATUSES.join(', ')}` }, { status: 400 })
  }

  try {
    await setPrereadRowStatus(id, rowStatus)
    return NextResponse.json({ ok: true, id, row_status: rowStatus })
  } catch (err) {
    const status = err instanceof Agent2UserError ? err.status : 500
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status })
  }
}

// DELETE /api/admin/prereads/[id] — permanent. The admin UI asks for
// confirmation first; the database keeps a copy of the deleted row in
// preread_deletions (migration_v54). 404s when nothing was deleted, so the UI
// can't report a delete that didn't happen.
export async function DELETE(request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params

  const { data, error } = await getSupabaseAdmin()
    .from('prereads')
    .delete()
    .eq('id', id)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) return NextResponse.json({ error: 'Preread not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
