'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import { removeFollower } from '@/lib/follow-writes'

/**
 * The "…" menu: the rare, hard-to-undo things you can do about a person.
 *
 * FOLLOWING AND UNFOLLOWING ARE NOT IN HERE. They used to be, and it was the
 * wrong split: following somebody back is the ordinary thing to want from a
 * followers list, and it was buried in the same menu as blocking them. It is a
 * button on the row now — see FollowToggle. What is left here is the set of
 * actions that are rare, negative, or hard to reverse, which is exactly what an
 * overflow menu is for.
 *
 * THREE ACTIONS THAT ARE NOT VARIATIONS ON ONE, which is why they are spelled
 * out separately instead of sharing a code path:
 *
 *   Remove follower  deletes THEIR follow of you — the opposite direction from
 *                    the unfollow on the row button, which is why the two are
 *                    named separately in lib/follow-writes.ts. They are not
 *                    told, and they may follow again straight away: immediately
 *                    if you are public, as a fresh request if you are private.
 *                    A "no thanks", not a "never", with nothing stored to make
 *                    it stick.
 *   Mute             hides their events from your feed. No access changes, the
 *                    follow in either direction is untouched, and there is
 *                    nothing for them to notice. Reversible here or in
 *                    Settings.
 *   Block            mutual and destructive: severs the follow in BOTH
 *                    directions and makes the two of you invisible to each
 *                    other. Confirmed before it runs, and undone only from
 *                    Settings — because afterwards you cannot reach their
 *                    profile to change your mind from.
 *
 * Every one of them is a write straight to Postgres under the policies in
 * migration_v48, the same arrangement FollowButton uses. Two things this
 * component deliberately does NOT do:
 *
 *   * sever the follow rows when blocking. A trigger does that inside the same
 *     transaction as the INSERT, so the two cannot come apart if the browser
 *     goes away mid-action.
 *   * tell the other person anything. There is no notification system in this
 *     app, and of everything it is missing, this is the feature least sorry
 *     about it.
 */

export type RelationshipAction = 'remove-follower' | 'mute' | 'unmute' | 'block'

export default function RelationshipMenu({
  targetId,
  targetUsername,
  muted,
  canRemoveFollower = false,
  onDone,
}: {
  targetId: string
  targetUsername: string
  /** Whether the viewer has muted this person, as of the last server read. */
  muted: boolean
  /**
   * True only in YOUR OWN followers list, where this person's follow of you is
   * yours to delete. A flag rather than a callback so that a SERVER component
   * can render this menu too — the profile page passes nothing.
   */
  canRemoveFollower?: boolean
  /**
   * Called after a successful write, so a list can drop the row it just acted
   * on. Absent on the profile page, where a router.refresh() is the whole
   * update.
   */
  onDone?: (action: RelationshipAction) => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  /**
   * Where the panel goes.
   *
   * POSITION: FIXED, ANCHORED TO THE TRIGGER, rather than absolute inside the
   * menu. An absolutely-positioned panel is clipped by the nearest scrolling
   * ancestor, and one of the two places this menu appears is the followers
   * sheet, which is `overflow-y: auto` — so the menu on the bottom row of a
   * list would have been cut in half. Fixed escapes that, at the cost of not
   * following the trigger when anything scrolls, which is why the menu closes
   * on scroll below. Closing beats drifting.
   */
  const [anchor, setAnchor] = useState<{ top?: number; bottom?: number; right: number } | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    setConfirming(false)
    setError(null)
    setAnchor(null)
  }, [])

  // Measured before paint so the panel never appears in the wrong place first.
  // Re-runs when `confirming` flips because that changes the panel's height,
  // which is what decides whether it still fits below the trigger.
  useLayoutEffect(() => {
    if (!open) return
    const el = triggerRef.current
    if (!el) return

    const r = el.getBoundingClientRect()
    const GAP = 6
    // A generous estimate of the tallest state (the block confirmation). Only
    // used to choose a side, so being a little over is the safe direction.
    const ESTIMATED_HEIGHT = confirming ? 200 : 170
    const fitsBelow = r.bottom + GAP + ESTIMATED_HEIGHT <= window.innerHeight

    setAnchor({
      right: Math.max(8, window.innerWidth - r.right),
      ...(fitsBelow
        ? { top: r.bottom + GAP }
        : { bottom: Math.max(8, window.innerHeight - r.top + GAP) }),
    })
  }, [open, confirming])

  // Click anywhere else, press Escape, or scroll, and the menu goes away.
  // Bound only while it is open so the page carries no listeners it is not
  // using. Scroll is captured so it catches the sheet's own scrolling, which
  // does not bubble.
  useEffect(() => {
    if (!open) return

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close()
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, close])

  async function run(action: RelationshipAction) {
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

    const { error } = await (() => {
      switch (action) {
        // Their edge, pointing at you — which v44's DELETE policy allows
        // precisely so that removing a follower is possible without blocking.
        case 'remove-follower':
          return removeFollower(supabase, me, targetId)

        case 'mute':
          return supabase.from('mutes').insert({ muter_id: me, muted_id: targetId })
        case 'unmute':
          return supabase.from('mutes').delete()
            .eq('muter_id', me).eq('muted_id', targetId)

        // The INSERT is the whole block: the trigger in migration_v48 deletes
        // the follows in both directions as part of this statement.
        case 'block':
          return supabase.from('blocks').insert({ blocker_id: me, blocked_id: targetId })
      }
    })()

    if (error) {
      // 23505 is the primary key — the row is already there, which means this
      // already happened (another tab, a double press that beat the disabled
      // state). The end state is the one we wanted, so treat it as done.
      if (!error.message.includes('duplicate key')) {
        setError(error.message)
        setBusy(false)
        return
      }
    }

    setBusy(false)
    close()

    if (onDone) onDone(action)

    // Blocking removes the profile you are standing on — profile_card() stops
    // returning it, so a refresh here would 404 the page you just used. Leave
    // instead, and land ON the unblock control rather than merely on the page
    // containing it: their profile is no longer somewhere you can get to, so
    // this is the only route back.
    if (action === 'block' && !onDone) {
      router.push('/settings#blocked')
      return
    }
    router.refresh()
  }

  const label = `More options for @${targetUsername}`

  return (
    <div className="ac-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ac-menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        disabled={busy}
      >
        {busy ? '…' : '···'}
      </button>

      {open && anchor && (
        <div className="ac-menu-panel" role="menu" aria-label={label} style={anchor}>
          {confirming ? (
            <div className="ac-menu-confirm">
              <p className="ac-menu-confirm-title">Block @{targetUsername}?</p>
              {/* Says what actually happens, including the two parts people
                  are most often surprised by: the follow in the OTHER
                  direction goes too, and unblocking does not bring either
                  back. */}
              <p className="ac-menu-confirm-note">
                You will stop following each other, neither of you will find the
                other in search or be able to open the other&rsquo;s profile, and
                they are not told. You can unblock from Settings — following
                again would be a fresh request.
              </p>
              <div className="ac-menu-confirm-row">
                <button
                  type="button"
                  className="ac-btn ac-btn--danger ac-btn--inline ac-btn--small"
                  onClick={() => run('block')}
                  disabled={busy}
                >
                  Block
                </button>
                <button
                  type="button"
                  className="ac-btn ac-btn--secondary ac-btn--inline ac-btn--small"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {canRemoveFollower && (
                <button
                  type="button"
                  role="menuitem"
                  className="ac-menu-item"
                  onClick={() => run('remove-follower')}
                  disabled={busy}
                >
                  Remove follower
                  <span className="ac-menu-note">
                    They are not told, and can follow you again.
                  </span>
                </button>
              )}

              <button
                type="button"
                role="menuitem"
                className="ac-menu-item"
                onClick={() => run(muted ? 'unmute' : 'mute')}
                disabled={busy}
              >
                {muted ? 'Unmute' : 'Mute'}
                <span className="ac-menu-note">
                  {muted
                    ? 'Their activity comes back to your feed.'
                    : 'Hides their activity from your feed. They are not told.'}
                </span>
              </button>

              <button
                type="button"
                role="menuitem"
                className="ac-menu-item ac-menu-item--danger"
                onClick={() => setConfirming(true)}
                disabled={busy}
              >
                Block
              </button>
            </>
          )}

          {error && <p className="ac-error ac-menu-error">{error}</p>}
        </div>
      )}
    </div>
  )
}
