import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

// GET /api/admin/books — all seed books for manual editor's pick selection
export async function GET() {
  const { data, error } = await getSupabaseAdmin()
    .from('seed_books')
    .select('id, title, author, source, goodreads_rating')
    .order('title', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
