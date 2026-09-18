import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { muteWarning, GROUP_WARNING_TYPE } from '@/lib/venue-warnings'

// POST /api/admin/exhibitions/[id]/artist-warning-mute
//
// "Don't ask me about this again at this venue." Silences the once-per-venue
// confirmation that a credited group show of 6+ artists should publish with its
// names hidden.
//
// Deliberately its own endpoint rather than a field on the exhibition PATCH: the
// two review actions are independent. Hiding the names on this one show is a
// PATCH of hide_artist_names and says nothing about future shows; muting is this
// call and says nothing about this show's names. In practice they are usually
// used together, but either alone has to work.
//
// The mute is keyed to the venue and the warning type, never the artist count —
// a venue muted after a 6-artist show stays muted for a 40-artist one.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params

  // The mute belongs to the venue, so the exhibition is only how we find it.
  const { data: exhibition, error } = await getSupabaseAdmin()
    .from('exhibitions')
    .select('id, venue_id')
    .eq('id', id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!exhibition) return NextResponse.json({ error: 'Exhibition not found' }, { status: 404 })

  const result = await muteWarning(exhibition.venue_id as string, GROUP_WARNING_TYPE, id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })

  return NextResponse.json({ ok: true, venue_id: exhibition.venue_id, warning_type: GROUP_WARNING_TYPE })
}
