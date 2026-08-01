import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// GET /api/admin/institutions — id/name list for admin dropdowns
export async function GET(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { data, error } = await getSupabaseAdmin()
    .from('institutions')
    .select('id, name')
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
