import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// GET /api/admin/prereads?exhibition_id=… — one show's prereads (blanked and
// flagged included) plus its preread_status, so the admin panel can refresh after
// a Retrigger or Replace without reloading every exhibition.
export async function GET(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const exhibitionId = request.nextUrl.searchParams.get('exhibition_id')
  if (!exhibitionId) return NextResponse.json({ error: 'exhibition_id is required' }, { status: 400 })

  const db = getSupabaseAdmin()
  const [{ data: ex, error: exError }, { data: rows, error: rowsError }] = await Promise.all([
    db.from('exhibitions').select('preread_status, missing_fields').eq('id', exhibitionId).single(),
    db.from('prereads')
      .select('id, article_title, publication, article_url, summary, thumbnail_url, artist_name, quality_flag, row_status, created_at')
      .eq('exhibition_id', exhibitionId)
      .order('created_at', { ascending: true }),
  ])
  if (exError || rowsError) return NextResponse.json({ error: (exError ?? rowsError)!.message }, { status: 500 })

  return NextResponse.json({ preread_status: ex?.preread_status ?? null, missing_fields: ex?.missing_fields ?? [], prereads: rows ?? [] })
}

// POST /api/admin/prereads — manually add a preread to an exhibition
export async function POST(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

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
    .select('id, article_title, publication, article_url, artist_name, quality_flag, row_status, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
