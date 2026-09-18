import 'server-only'

import { getSupabaseServer } from '@/lib/supabase-server'
import type { ProfilePrivacy } from '@/lib/profile'

/**
 * Reading the two relationships that are not follows: mutes and blocks.
 *
 * WRITES ARE NOT HERE, the same arrangement lib/follows.ts describes. Muting,
 * unmuting, blocking and unblocking all happen in the browser against the
 * policies in migration_v48 — see components/account/RelationshipMenu.tsx. The
 * database is what decides who may do what, so a server route in front of it
 * could only re-state rules it has no power to add to.
 *
 * WHY TWO OF EVERYTHING RATHER THAN ONE "RELATIONSHIP" SHAPE: a mute and a
 * block are different in kind, not in degree. A mute is one-directional,
 * silent, and changes exactly one thing — whether somebody's events reach your
 * feed. A block is mutual, severs the follow graph in both directions when it
 * is created, and makes two accounts invisible to each other. Sharing a type
 * between them would invite code that treats "has a relationship row" as the
 * question, and that question has no correct answer.
 *
 * WHAT IS DELIBERATELY ABSENT: any function that answers "has X blocked Y" for
 * two people who are not the caller, and any that answers "who has blocked
 * me". The first does not exist because nothing needs it — the gates all live
 * in the database. The second does not exist because the whole design turns on
 * a blocked person being unable to find out.
 */

/** A person as they appear in the blocked or muted list. */
export interface RelationshipPerson {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  privacy: ProfilePrivacy
  /** When the block or mute was made — not when the profile was created. */
  created_at: string
}

/**
 * Who the signed-in person has blocked, newest first.
 *
 * Read through public.blocked_profiles(), which takes no argument and answers
 * only about its caller. It has to be SECURITY DEFINER: migration_v48 stops a
 * blocker from reading the profile row of somebody they blocked, so without
 * elevation this list would be a column of UUIDs with no names on it.
 *
 * Never throws. Losing this list should cost the settings page a section, not
 * the whole page.
 */
export async function getBlockedProfiles(): Promise<RelationshipPerson[]> {
  return readList('blocked_profiles')
}

/** Who the signed-in person has muted, newest first. */
export async function getMutedProfiles(): Promise<RelationshipPerson[]> {
  return readList('muted_profiles')
}

async function readList(fn: 'blocked_profiles' | 'muted_profiles'): Promise<RelationshipPerson[]> {
  try {
    const supabase = await getSupabaseServer()
    const { data, error } = await supabase.rpc(fn)

    if (error) {
      console.error(`[relationships] ${fn} failed:`, error.message)
      return []
    }
    return (data ?? []) as RelationshipPerson[]
  } catch (err) {
    console.error(`[relationships] ${fn} threw:`, err)
    return []
  }
}

/**
 * Has the signed-in person muted this profile?
 *
 * Queried straight against public.mutes rather than through a function,
 * because this is the one question about the table that needs no elevation:
 * the read policy in migration_v48 already narrows it to the caller's own
 * rows, so a row coming back IS the answer and a row that belongs to somebody
 * else cannot come back.
 *
 * Returns false when signed out — a visitor with no account has muted nobody.
 * Also returns false on failure, which is the safe direction here: the cost of
 * being wrong is a menu offering "Mute" to somebody who already muted, and
 * pressing it is a no-op conflict the database refuses. Failing the other way
 * would hide the Unmute they need.
 */
export async function isMuted(viewerId: string | null, profileId: string): Promise<boolean> {
  if (!viewerId || viewerId === profileId) return false

  try {
    const supabase = await getSupabaseServer()
    const { data, error } = await supabase
      .from('mutes')
      .select('muted_id')
      .eq('muter_id', viewerId)
      .eq('muted_id', profileId)
      .maybeSingle()

    if (error) {
      console.error('[relationships] mute lookup failed:', error.message)
      return false
    }
    return data !== null
  } catch (err) {
    console.error('[relationships] mute lookup threw:', err)
    return false
  }
}
