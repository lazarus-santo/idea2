import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { geocodeAddress } from '@/lib/geocode'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { picksReferencing } from '@/lib/editor-picks'

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
  // Display only — never affects what is stored in exhibition_artists.
  'hide_artist_names',
] as const

// PATCH /api/admin/exhibitions/[id]
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

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
export async function DELETE(request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params

  // Refuse to delete a show an editor's pick points at, live or retired.
  // editor_picks.reference_id is a bare uuid with no foreign key and no cached
  // title, so deleting the row makes that pick permanently unrepairable — and if
  // the pick is live, its slot on the Editor's Picks page just goes empty with no
  // error anywhere. This has already happened once: the 2026-05-31 exhibition pick
  // points at a show that no longer exists.
  const { picks, error: pickErr } = await picksReferencing('exhibition', id)
  if (pickErr) {
    return NextResponse.json({ error: `Could not check editor's picks: ${pickErr}` }, { status: 500 })
  }
  if (picks.length > 0) {
    const live = picks.some((p) => p.status === 'live')
    return NextResponse.json(
      {
        error: `This exhibition is ${live ? 'the live' : 'a retired'} editor's pick. `
          + 'Replace or remove that pick before deleting the exhibition.',
        pick_ids: picks.map((p) => p.id),
      },
      { status: 409 }
    )
  }

  const { error } = await getSupabaseAdmin()
    .from('exhibitions')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
