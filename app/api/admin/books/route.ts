import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// GET /api/admin/books — all seed books for manual editor's pick selection
export async function GET(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { data, error } = await getSupabaseAdmin()
    .from('seed_books')
    .select('id, title, author, source, goodreads_rating')
    .order('title', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
