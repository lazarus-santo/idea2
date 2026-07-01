import { NextResponse } from 'next/server'
import he from 'he'
import { getSupabaseAdmin } from '@/lib/supabase'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const category = searchParams.get('category')

  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  let query = getSupabaseAdmin()
    .from('readings')
    .select('*, publications(name)')
    .gte('published_at', cutoff)
    .order('published_at', { ascending: false })
    .limit(200)

  if (category && ['news', 'opinion', 'conversation'].includes(category)) {
    query = query.eq('category', category)
  }

  const { data, error } = await query

  if (error) {
    console.error('Failed to fetch river:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalized = (data ?? []).map(({ publications, ...r }: any) => ({
    ...r,
    headline: r.headline ? he.decode(r.headline) : r.headline,
    author: r.author ? he.decode(r.author) : r.author,
    thumbnail_url: r.thumbnail_url ?? null,
    publication_name: publications?.name ?? null,
  }))

  return NextResponse.json(normalized)
}
