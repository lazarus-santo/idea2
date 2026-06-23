import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { auditAndRepairPrereads } from '@/lib/audit'

// POST /api/admin/exhibitions/[id]/approve
// Publishes the exhibition and fires prereads generation in the background.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const { error } = await getSupabaseAdmin()
    .from('exhibitions')
    .update({ status: 'published', missing_fields: [] })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  auditAndRepairPrereads([id]).catch(console.error)

  return NextResponse.json({ ok: true })
}
