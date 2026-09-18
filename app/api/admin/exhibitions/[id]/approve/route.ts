import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { runAgent2ForExhibition } from '@/lib/agent2'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// POST /api/admin/exhibitions/[id]/approve
// Publishes the exhibition and fires prereads generation in the background.
export async function POST(request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params
  const db = getSupabaseAdmin()

  // Read current end_date — if absent, mark is_ongoing on publish
  const { data: current } = await db.from('exhibitions').select('end_date').eq('id', id).single()
  const isOngoing = !current?.end_date

  const { error } = await db
    .from('exhibitions')
    .update({ status: 'published', missing_fields: [], ...(isOngoing ? { is_ongoing: true } : {}) })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Agent 2 by the same status rules as an Agent 1 run (lib/agent2.ts): a show
  // that already has its prereads is skipped, one never attempted is generated.
  runAgent2ForExhibition(id, { mode: 'auto' }).catch(console.error)

  return NextResponse.json({ ok: true })
}
