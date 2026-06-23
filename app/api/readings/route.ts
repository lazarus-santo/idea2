import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await getSupabaseAdmin()
    .from('readings')
    .select('*, publications(name)')
    .order('published_at', { ascending: false })
    .limit(100)

  if (error) {
    console.error('Failed to fetch readings:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalized = (data ?? []).map(({ publications, ...r }: any) => ({
    ...r,
    thumbnail_url: r.thumbnail_url ?? null,
    publication_name: publications?.name ?? null,
  }))

  return NextResponse.json(normalized)
}
