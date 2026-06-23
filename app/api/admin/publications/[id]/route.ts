import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

// PATCH /api/admin/publications/[id] — approve or reject a publication domain
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { status } = await request.json()

  if (!['approved', 'rejected'].includes(status)) {
    return NextResponse.json({ error: 'status must be approved or rejected' }, { status: 400 })
  }

  const { error } = await getSupabaseAdmin()
    .from('publications')
    .update({ status })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
