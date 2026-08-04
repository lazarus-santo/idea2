import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// POST /api/admin/editor-picks/[id]/approve — make this pick the live one.
//
// There is no scheduling. The route used to take { mode: 'now' | 'scheduled' },
// where 'scheduled' parked the pick at status='pending' with goes_live_at set to
// the next Monday — but nothing ever read goes_live_at, so a scheduled pick
// simply never went live. Picks are now published when you publish them.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params
  const db = getSupabaseAdmin()

  const { data: pick, error: fetchErr } = await db
    .from('editor_picks')
    .select('pick_type')
    .eq('id', id)
    .single()

  if (fetchErr || !pick) {
    return NextResponse.json({ error: fetchErr?.message ?? 'Not found' }, { status: 404 })
  }

  // Retire the incumbent before promoting this one. Ordering is load-bearing:
  // editor_picks_one_live_per_type (migration_v27) is a partial unique index on
  // (pick_type) WHERE status = 'live', so promoting first would hit a 23505.
  // neq('status','past') rather than .in() so any stale row created outside the
  // admin is caught too.
  const { error: retireErr } = await db
    .from('editor_picks')
    .update({ status: 'past' })
    .eq('pick_type', pick.pick_type)
    .neq('status', 'past')
    .neq('id', id)
  if (retireErr) console.error('retire error:', retireErr.message)

  const { error } = await db
    .from('editor_picks')
    .update({ status: 'live' })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, status: 'live' })
}
