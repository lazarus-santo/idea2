import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// GET /api/admin/institutions — id/name list for admin dropdowns
//
// status/status_note come along so the admin can see which galleries are marked
// closed or not relevant without a second request. Non-active institutions stay
// in the list on purpose: they need to be visible to be un-marked.
export async function GET(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { data, error } = await getSupabaseAdmin()
    .from('institutions')
    .select('id, name, status, status_note, active')
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
