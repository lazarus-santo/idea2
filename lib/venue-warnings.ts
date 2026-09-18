// Per-venue review prompts the admin has silenced.
//
// One row in venue_artist_warnings per (venue, warning_type) means "stop asking
// me about this at this venue". Presence is the mute; there is no boolean to fall
// out of sync with. See supabase/migration_v50.sql.
//
// Everything here fails safe toward ASKING. If the table is missing (the
// migration has not been applied yet) or the read errors, the venue reads as
// un-muted, so the show goes to pending review and a person sees it. The opposite
// default would silently auto-publish the very thing the prompt exists to confirm.

import { getSupabaseAdmin } from './supabase'
import { GROUP_WARNING_TYPE } from './artist-rules'

export { GROUP_WARNING_TYPE }

/**
 * Has this venue already had this warning confirmed and silenced?
 *
 * Returns false on any error, which routes the show to review rather than
 * publishing it unseen.
 */
export async function isWarningMuted(
  venueId: string,
  warningType: string = GROUP_WARNING_TYPE
): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from('venue_artist_warnings')
    .select('id')
    .eq('venue_id', venueId)
    .eq('warning_type', warningType)
    .maybeSingle()

  if (error) {
    // 42P01 is "relation does not exist" — expected until migration_v50 is applied.
    console.warn(`[venue-warnings] Could not read mute for venue ${venueId}: ${error.message}`)
    return false
  }
  return data !== null
}

/**
 * Silences this warning for this venue, from the admin's "don't ask again".
 *
 * Idempotent: the unique (venue_id, warning_type) pair means a second call is a
 * duplicate-key no-op rather than a second row.
 */
export async function muteWarning(
  venueId: string,
  warningType: string = GROUP_WARNING_TYPE,
  exhibitionId: string | null = null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await getSupabaseAdmin()
    .from('venue_artist_warnings')
    .insert({ venue_id: venueId, warning_type: warningType, exhibition_id: exhibitionId })

  // Already muted is success, not failure.
  if (error && error.code !== '23505') return { ok: false, error: error.message }
  return { ok: true }
}

/** Lets the admin re-enable a prompt. Not wired to a control yet. */
export async function unmuteWarning(
  venueId: string,
  warningType: string = GROUP_WARNING_TYPE
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await getSupabaseAdmin()
    .from('venue_artist_warnings')
    .delete()
    .eq('venue_id', venueId)
    .eq('warning_type', warningType)

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
