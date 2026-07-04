import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { geocodeAddress } from '@/lib/geocode'

const PATCHABLE = [
  'status',
  'show_title',
  'image_url',
  'start_date',
  'end_date',
  'is_ongoing',
  'description',
  'press_release',
  'missing_fields',
  'address_override',
  'address_override_neighborhood',
  'admin_notes',
] as const

// PATCH /api/admin/exhibitions/[id]
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()

  const update: Record<string, unknown> = {}
  for (const key of PATCHABLE) {
    if (key in body) update[key] = body[key] ?? null
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No patchable fields provided' }, { status: 400 })
  }

  // When address_override changes, geocode the new address and cache the result
  if ('address_override' in body) {
    if (body.address_override) {
      const coords = await geocodeAddress(body.address_override)
      update.override_latitude = coords?.lat ?? null
      update.override_longitude = coords?.lng ?? null
    } else {
      update.override_latitude = null
      update.override_longitude = null
    }
  }

  const { error } = await getSupabaseAdmin()
    .from('exhibitions')
    .update(update)
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// DELETE /api/admin/exhibitions/[id]
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const { error } = await getSupabaseAdmin()
    .from('exhibitions')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
