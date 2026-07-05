import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

// GET /api/admin/scraper-feedback — downloads all admin_notes as a .txt file
export async function GET() {
  const db = getSupabaseAdmin()

  const [{ data, error }, { data: missingShows, error: missingShowsError }] = await Promise.all([
    db
      .from('exhibitions')
      .select(`
        show_title, status, created_at, admin_notes, missing_fields,
        venues!inner(institutions!inner(name))
      `)
      .not('admin_notes', 'is', null)
      .neq('admin_notes', '')
      .order('created_at', { ascending: false }),
    db
      .from('agent1_missing_show_reports')
      .select('exhibition_name, notes, reported_at, institutions(name)')
      .eq('resolved', false)
      .order('reported_at', { ascending: false }),
  ])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (missingShowsError) return NextResponse.json({ error: missingShowsError.message }, { status: 500 })

  const today = new Date().toISOString().slice(0, 10)
  let txt = `SCRAPER FEEDBACK EXPORT — ${today}\n\n`

  for (const ex of data ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = ex as any
    const inst = raw.venues?.institutions?.name ?? '(unknown)'
    const scraped = ex.created_at ? ex.created_at.slice(0, 10) : '?'
    const missing = Array.isArray(ex.missing_fields) && ex.missing_fields.length > 0
      ? ex.missing_fields.join(', ')
      : null

    txt += `${inst} — ${ex.show_title}\n`
    txt += `Status: ${ex.status}\n`
    txt += `Scraped: ${scraped}\n`
    txt += `Feedback: ${ex.admin_notes}\n`
    if (missing) txt += `Missing fields: ${missing}\n`
    txt += '---\n\n'
  }

  if (missingShows && missingShows.length > 0) {
    txt += `MISSING SHOW REPORTS — ${today}\n\n`
    for (const report of missingShows) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = report as any
      const inst = raw.institutions?.name ?? '(unknown)'
      const reported = report.reported_at ? report.reported_at.slice(0, 10) : '?'

      txt += `${inst} — "${report.exhibition_name}"\n`
      txt += `Reported: ${reported}\n`
      txt += `Notes: ${report.notes ?? '(none)'}\n`
      txt += '---\n\n'
    }
  }

  return new NextResponse(txt, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="scraper-feedback-${today}.txt"`,
    },
  })
}
