import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

// POST /api/admin/prereads — manually add a preread to an exhibition
export async function POST(request: NextRequest) {
  const body = await request.json()
  const { exhibition_id, article_url, article_title, publication } = body

  if (!exhibition_id || !article_url) {
    return NextResponse.json({ error: 'exhibition_id and article_url are required' }, { status: 400 })
  }

  const { data, error } = await getSupabaseAdmin()
    .from('prereads')
    .insert({
      exhibition_id,
      article_url,
      article_title: article_title ?? null,
      publication: publication ?? null,
    })
    .select('id, article_title, publication, article_url')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
