'use client'

import { useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import { follow, unfollow } from '@/lib/follow-writes'
import type { FollowStatus } from '@/lib/follows'

/** Where the viewer stands with one person in a list. */
export type RowFollowState = FollowStatus | 'none'

/**
 * Follow, unfollow, or withdraw a request — from a row in a list.
 *
 * WHY THIS IS A BUTTON AND NOT A MENU ITEM. Following somebody back is the
 * ordinary, frequent, positive thing to do with a follower, and it was the one
 * action the followers list did not offer: you could remove them, mute them or
 * block them, but not follow them. Hiding the only action most people want
 * behind "···" while the three they rarely want are also behind it gets the
 * weighting exactly backwards. Remove, mute and block stay in the menu because
 * they are rare and hard to undo; this is neither.
 *
 * IT APPEARS ON EVERY LIST, not only your own followers. A row is a person, and
 * whether you follow them has nothing to do with whose list you found them in.
 * Offering it in one sheet and not the other would be an asymmetry with no
 * reason behind it.
 *
 * The label reads as the CURRENT STATE, not as an instruction — "Following"
 * rather than "Unfollow" — matching the button on the profile page, so the same
 * relationship is described the same way in both places. Pressing it undoes
 * whatever that state is.
 *
 * WHAT IT DOES NOT DECIDE: whether a follow lands as pending or approved. It
 * sends the pair and reports back what the database made of it — a trigger sets
 * the status from the target's privacy and the client cannot name the column.
 * See lib/follow-writes.ts.
 */
export default function FollowToggle({
  targetId,
  targetUsername,
  state,
  onChanged,
}: {
  targetId: string
  targetUsername: string
  state: RowFollowState
  /**
   * The new state, once the database has confirmed it. The list uses this both
   * to relabel the button and to decide whether the row still belongs where it
   * is — unfollowing from your own Following list empties that row of its
   * reason to be there.
   */
  onChanged: (next: RowFollowState) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act() {
    setBusy(true)
    setError(null)

    const supabase = getSupabaseBrowser()
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) {
      setError('Sign in again to do that.')
      setBusy(false)
      return
    }
    const me = auth.user.id

    if (state === 'none') {
      const { error } = await follow(supabase, me, targetId)

      // 23505 is the primary key: a row for this pair already exists, so the
      // graph moved under us — another tab, or a double press that beat the
      // disabled state. Re-reading is the only honest way to find out where it
      // landed.
      if (error && !error.message.includes('duplicate key')) {
        setError(error.message)
        setBusy(false)
        return
      }

      // READ BACK RATHER THAN ASSUME. A public target lands on 'approved' and a
      // private one on 'pending', and a block makes the insert do nothing at
      // all without raising — so the row may still be absent. Guessing here
      // would put a button on screen that says something the database does not.
      const { data } = await supabase
        .from('follows')
        .select('status')
        .eq('follower_id', me)
        .eq('followed_id', targetId)
        .maybeSingle<{ status: FollowStatus }>()

      setBusy(false)
      onChanged(data?.status ?? 'none')
      return
    }

    const { error } = await unfollow(supabase, me, targetId)
    if (error) {
      setError(error.message)
      setBusy(false)
      return
    }

    setBusy(false)
    onChanged('none')
  }

  const label =
    state === 'approved' ? 'Following'
    : state === 'pending' ? 'Requested'
    : 'Follow'

  // Requested and Following are both "press to undo", so they read as the
  // current state and sit back as secondary. Follow is the invitation.
  const secondary = state !== 'none'

  return (
    <button
      type="button"
      className={`ac-btn ac-btn--inline ac-btn--small${secondary ? ' ac-btn--secondary' : ''}`}
      onClick={act}
      disabled={busy}
      title={error ?? undefined}
      aria-label={
        state === 'approved' ? `Unfollow @${targetUsername}`
        : state === 'pending' ? `Cancel your follow request to @${targetUsername}`
        : `Follow @${targetUsername}`
      }
    >
      {busy ? '…' : label}
    </button>
  )
}
