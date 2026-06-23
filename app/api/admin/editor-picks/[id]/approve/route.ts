import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

function nextMonday(): string {
  const d = new Date()
  const day = d.getDay() // 0=Sun … 6=Sat
  const daysUntil = day === 1 ? 7 : (8 - day) % 7
  d.setDate(d.getDate() + daysUntil)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

// POST /api/admin/editor-picks/[id]/approve
// body: { mode: 'now' | 'scheduled' }
// 'now'       → status='live'    immediately
// 'scheduled' → status='pending', goes_live_at=next Monday
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const mode: 'now' | 'scheduled' = body.mode === 'now' ? 'now' : 'scheduled'

  const db = getSupabaseAdmin()

  const { data: pick, error: fetchErr } = await db
    .from('editor_picks')
    .select('pick_type')
    .eq('id', id)
    .single()

  if (fetchErr || !pick) {
    return NextResponse.json({ error: fetchErr?.message ?? 'Not found' }, { status: 404 })
  }

  // Retire ALL existing live and pending picks of the same type.
  // We use neq('status','past') rather than .in() so any stale 'live' rows
  // created outside the admin are also caught.
  const { error: retireErr } = await db
    .from('editor_picks')
    .update({ status: 'past' })
    .eq('pick_type', pick.pick_type)
    .neq('status', 'past')
    .neq('id', id)
  if (retireErr) console.error('retire error:', retireErr.message)

  const goesLiveAt = mode === 'now' ? null : nextMonday()
  const status     = mode === 'now' ? 'live' : 'pending'

  const { error } = await db
    .from('editor_picks')
    .update({ status, goes_live_at: goesLiveAt })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, status, goes_live_at: goesLiveAt })
}
