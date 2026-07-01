import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { fetchOgImage } from '@/lib/readings-curator'

function isAuthorized(request: Request): boolean {
  const adminSecret = request.headers.get('x-admin-secret')
  return !!(adminSecret && adminSecret === process.env.ADMIN_PASSWORD)
}

// POST /api/admin/backfill-thumbnails — fetch OG images for readings with null thumbnail_url
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = getSupabaseAdmin()
  const { data: readings, error } = await db
    .from('readings')
    .select('id, article_url')
    .is('thumbnail_url', null)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!readings || readings.length === 0) return NextResponse.json({ updated: 0, skipped: 0 })

  let updated = 0
  let skipped = 0

  for (const r of readings) {
    const imgUrl = await fetchOgImage(r.article_url as string)
    if (imgUrl) {
      await db.from('readings').update({ thumbnail_url: imgUrl }).eq('id', r.id)
      updated++
    } else {
      skipped++
    }
  }

  return NextResponse.json({ updated, skipped, total: readings.length })
}
