import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

// GET /api/admin/missing-show-reports — unresolved reports for admin display/export
export async function GET() {
  const { data, error } = await getSupabaseAdmin()
    .from('agent1_missing_show_reports')
    .select('id, institution_id, exhibition_name, notes, reported_at, resolved, institutions(name)')
    .eq('resolved', false)
    .order('reported_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

// POST /api/admin/missing-show-reports — admin reports a show missing from a scrape
export async function POST(request: NextRequest) {
  const body = await request.json()
  const { institution_id, exhibition_name, notes } = body

  if (!institution_id || !exhibition_name?.trim()) {
    return NextResponse.json({ error: 'institution_id and exhibition_name are required' }, { status: 400 })
  }

  const { error } = await getSupabaseAdmin()
    .from('agent1_missing_show_reports')
    .insert({ institution_id, exhibition_name: exhibition_name.trim(), notes: notes?.trim() || null })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
