import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { generatePrereads } from '@/lib/claude'
import type { ExhibitionRaw } from '@/lib/types'

// POST /api/debug-prereads?show=furniture
// Deletes and regenerates prereads for a specific show title (case-insensitive partial match).
export async function POST(request: NextRequest) {
  const filter = request.nextUrl.searchParams.get('show')?.toLowerCase() ?? ''
  const db = getSupabaseAdmin()

  const { data: exhibitions, error } = await db
    .from('exhibitions')
    .select(`
      id, show_title, start_date, end_date, description, image_url, press_release,
      venues!inner(name)
    `)
    .ilike('show_title', `%${filter}%`)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!exhibitions?.length) {
    return NextResponse.json({ error: `No exhibition matching "${filter}"` }, { status: 404 })
  }

  const results = []

  for (const ex of exhibitions) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const venue = (ex.venues as any) as { name: string }
    const artistRows = await db
      .from('exhibition_artists')
      .select('artists(name)')
      .eq('exhibition_id', ex.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const artists = ((artistRows.data ?? []) as any[])
      .map((r: { artists: { name: string } | null }) => r.artists?.name)
      .filter(Boolean) as string[]

    const raw: ExhibitionRaw & { venue_name: string } = {
      show_title: ex.show_title,
      artists,
      start_date: ex.start_date,
      end_date: ex.end_date,
      description: ex.description,
      press_release: ex.press_release,
      image_url: ex.image_url,
      venue_name: venue.name,
    }

    await db.from('prereads').delete().eq('exhibition_id', ex.id)
    const { prereads, hasShowCoverage } = await generatePrereads(raw)

    if (prereads.length > 0) {
      await db.from('prereads').insert(prereads.map((p) => ({ ...p, exhibition_id: ex.id })))
    }

    // Update missing_fields to reflect whether show-specific coverage was found
    const { data: exRow } = await db.from('exhibitions').select('missing_fields').eq('id', ex.id).single()
    const currentMissing: string[] = (exRow?.missing_fields ?? []) as string[]
    const withoutCoverage = currentMissing.filter((f) => f !== 'show_coverage')
    const updatedMissing = hasShowCoverage ? withoutCoverage : [...withoutCoverage, 'show_coverage']
    await db.from('exhibitions').update({ missing_fields: updatedMissing }).eq('id', ex.id)

    results.push({ show_title: ex.show_title, venue: venue.name, has_show_coverage: hasShowCoverage, prereads_generated: prereads.length, prereads })
  }

  return NextResponse.json(results)
}
