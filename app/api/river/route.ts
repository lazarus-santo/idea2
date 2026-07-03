import { NextResponse } from 'next/server'
import he from 'he'
import { getSupabaseAdmin } from '@/lib/supabase'

const RIVER_GROUPS = ['news', 'art_market', 'people', 'opinion']
const CATEGORIES = [
  'breaking_news', 'institutional_news', 'art_market', 'interview', 'opinion', 'show_review', 'show_roundup',
]

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const group = searchParams.get('group')
  const category = searchParams.get('category')

  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  let query = getSupabaseAdmin()
    .from('readings')
    .select('*, publications(name)')
    .gte('published_at', cutoff)
    .order('published_at', { ascending: false })
    .limit(200)

  if (group && RIVER_GROUPS.includes(group)) {
    query = query.eq('river_group', group)
  } else if (category && CATEGORIES.includes(category)) {
    // Backward-compatible: filters by category directly rather than river_group.
    query = query.eq('category', category)
  }

  const { data, error } = await query

  if (error) {
    console.error('Failed to fetch river:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalized = (data ?? []).map(({ publications, rss_summary, ...r }: any) => ({
    ...r,
    headline: r.headline ? he.decode(r.headline) : r.headline,
    author: r.author ? he.decode(r.author) : r.author,
    thumbnail_url: r.thumbnail_url ?? null,
    publication_name: publications?.name ?? null,
  }))

  return NextResponse.json(normalized)
}
