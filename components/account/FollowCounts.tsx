'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import RelationshipMenu, { type RelationshipAction } from '@/components/account/RelationshipMenu'
import FollowToggle, { type RowFollowState } from '@/components/account/FollowToggle'
import type { FollowCounts as Counts, FollowPerson, FollowStatus } from '@/lib/follows'

type Direction = 'followers' | 'following'

/**
 * The two numbers on a profile, and the lists behind them.
 *
 * COUNTS ARE PUBLIC ON EVERY PROFILE, private ones included — knowing an
 * account has forty followers says nothing about who they are. THE LISTS ARE
 * NOT: on a private profile they open only for the owner and for approved
 * followers, because a list of names is contents, and withholding contents from
 * people who have not been let in is the whole point of the locked state.
 *
 * `listsOpen` carries that decision down from the page, which already knows
 * whether this visitor got the profile's contents. The database enforces it
 * again regardless — profile_followers() and profile_following() each refuse a
 * caller who cannot see the profile — so this flag only decides whether the
 * numbers look pressable, never whether the data is safe.
 *
 * Fetched when a list is first opened rather than with the page: most people
 * looking at a profile never open either one.
 *
 * ---------------------------------------------------------------------------
 * WHAT A ROW OFFERS: A BUTTON FOR THE COMMON THING, A MENU FOR THE REST
 *
 * The two directions of a follow are independent facts, and a row has to be
 * able to express both:
 *
 *   do I follow THEM?   → the button: Follow / Requested / Following.
 *                         Present on every row in every list, because whether
 *                         you follow somebody has nothing to do with whose
 *                         list you happened to find them in. This is what a
 *                         followers list needs in order to be a place you can
 *                         follow back from — without it you could remove,
 *                         mute or block a follower but not follow them, which
 *                         is the one thing most people open the list to do.
 *
 *   do THEY follow me?  → "Remove follower" in the menu, and only in YOUR OWN
 *                         followers list, where that edge exists and is yours
 *                         to delete. It is the opposite direction from the
 *                         button's unfollow, which is why the two are named
 *                         apart in lib/follow-writes.ts rather than sharing a
 *                         statement with a flag.
 *
 * Mute and block sit in the menu on every row but your own: they are about you
 * and that person, not about the list.
 *
 * Blocked accounts never reach these lists at all — profile_followers() and
 * profile_following() drop them, in both directions, even inside a third
 * party's list. So the menu here only ever offers Block, never Unblock; undoing
 * one happens in Settings, which is the only place the person is still visible.
 */
export default function FollowCounts({
  profileId,
  counts,
  listsOpen,
  viewerId,
  isOwnProfile,
}: {
  profileId: string
  counts: Counts
  listsOpen: boolean
  /** The signed-in person, or null. Their own row never gets a menu. */
  viewerId: string | null
  /** Whether these lists belong to the person reading them. */
  isOwnProfile: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState<Direction | null>(null)
  const [people, setPeople] = useState<FollowPerson[] | null>(null)
  const [muted, setMuted] = useState<Set<string>>(new Set())
  // Only the rows the viewer follows appear here; anybody absent is 'none'.
  const [followed, setFollowed] = useState<Map<string, FollowStatus>>(new Map())
  const [error, setError] = useState<string | null>(null)

  const requestRef = useRef(0)

  const close = useCallback(() => {
    // Bumping the ticket abandons any list still loading, so it cannot land in
    // a sheet the person has already dismissed.
    requestRef.current++
    setOpen(null)
    setPeople(null)
    setFollowed(new Map())
    setError(null)
  }, [])

  /**
   * Opening a list is what fetches it — not an effect watching `open`. The
   * fetch is caused by the click, so it belongs in the handler; React 19's
   * compiler flags the effect spelling because the state resets inside it
   * cascade an extra render before the request has even left.
   */
  async function openList(direction: Direction) {
    setOpen(direction)
    setPeople(null)
    setError(null)

    // Which request this is. The sheet may be closed, or the other list
    // opened, while this one is in flight; the counter is what lets a stale
    // answer be dropped rather than rendered under the wrong heading. A ref
    // rather than state, because changing it must not itself re-render.
    const ticket = ++requestRef.current

    const supabase = getSupabaseBrowser()
    const fn = direction === 'followers' ? 'profile_followers' : 'profile_following'

    const listRes = await supabase.rpc(fn, { profile_id: profileId })

    if (ticket !== requestRef.current) return

    if (listRes.error) {
      console.error('[follows] list failed:', listRes.error.message)
      setError('That list could not be loaded.')
      return
    }

    const rows = (listRes.data ?? []) as FollowPerson[]
    const ids = rows.map(r => r.id)

    /*
     * Then the two annotations each row's controls need: whether the viewer
     * has muted this person, and whether they follow them.
     *
     * A SECOND ROUND TRIP RATHER THAN A PARALLEL ONE, deliberately. Both
     * queries are scoped with .in() to the ids the list actually returned, and
     * the ids do not exist until the list comes back. The alternative — firing
     * them alongside the list and fetching the viewer's ENTIRE mute and follow
     * sets — works today at two accounts and turns into "download my whole
     * follow graph to label 200 rows" later.
     *
     * The list is not rendered until both land, so the buttons never flash
     * "Follow" at somebody the viewer already follows. That costs a beat on
     * opening a sheet, which is a deliberate click, not a page load.
     *
     * Read straight from public.mutes and public.follows: the policies already
     * narrow both to the caller's own rows, so neither needs a function to keep
     * it honest. Signed-out visitors get no controls at all and skip this.
     */
    if (!viewerId || ids.length === 0) {
      setMuted(new Set())
      setFollowed(new Map())
      setPeople(rows)
      return
    }

    const [muteRes, followRes] = await Promise.all([
      supabase.from('mutes').select('muted_id')
        .eq('muter_id', viewerId).in('muted_id', ids),
      supabase.from('follows').select('followed_id, status')
        .eq('follower_id', viewerId).in('followed_id', ids),
    ])

    if (ticket !== requestRef.current) return

    // A failed annotation costs the row its label, not the list. Pressing
    // Follow on somebody already followed is a duplicate key, which the toggle
    // treats as "already done" and then re-reads.
    if (muteRes.error) {
      console.error('[relationships] mute states failed:', muteRes.error.message)
    }
    if (followRes.error) {
      console.error('[follows] follow states failed:', followRes.error.message)
    }

    setMuted(new Set(((muteRes.data ?? []) as { muted_id: string }[]).map(m => m.muted_id)))
    setFollowed(new Map(
      ((followRes.data ?? []) as { followed_id: string, status: FollowStatus }[])
        .map(f => [f.followed_id, f.status])
    ))
    setPeople(rows)
  }

  /**
   * What a finished menu action does to the list under it.
   *
   * Remove-follower and block both mean the row no longer belongs in the list
   * that is open, so it goes immediately rather than after a refetch — the
   * sheet is already showing the answer and re-reading would only make it
   * flicker. Mute and unmute change nothing about who is in the list, only
   * what the menu should say next time.
   */
  const afterAction = useCallback((personId: string) => (action: RelationshipAction) => {
    if (action === 'mute' || action === 'unmute') {
      setMuted(prev => {
        const next = new Set(prev)
        if (action === 'mute') next.add(personId)
        else next.delete(personId)
        return next
      })
      return
    }
    setPeople(prev => prev?.filter(p => p.id !== personId) ?? prev)
  }, [])

  /**
   * And what the follow button does to it.
   *
   * Relabelling is always right. Dropping the row is right in exactly one
   * case: YOUR OWN Following list is defined by the follows this button just
   * deleted, so a row that is no longer followed has nothing keeping it there.
   * In a followers list the same unfollow changes nothing about whether they
   * follow you, so the row stays — which is the asymmetry that makes these two
   * lists different things rather than two views of one.
   */
  const afterFollowChange = useCallback(
    (personId: string, direction: Direction) => (next: RowFollowState) => {
      // Narrowed rather than asserted. 'signed-out' cannot arrive here — that
      // state renders a link, which never reports back — but the map holds
      // live follow statuses only, so anything that is not one means "no edge".
      const edge = next === 'approved' || next === 'pending' ? next : null

      setFollowed(prev => {
        const map = new Map(prev)
        if (edge) map.set(personId, edge)
        else map.delete(personId)
        return map
      })

      if (!edge && isOwnProfile && direction === 'following') {
        setPeople(prev => prev?.filter(p => p.id !== personId) ?? prev)
      }

      // The two numbers above the sheet are server-rendered, and following
      // somebody from inside it moves one of them. Without this, you follow a
      // person back, close the sheet, and your own "following" count still
      // says what it said a minute ago.
      //
      // Safe to do with the sheet open: this re-renders the server components
      // around this one and hands down fresh counts, but does not unmount it,
      // so the open list and everything loaded into it survive. RelationshipMenu
      // already refreshes after its own writes for the same reason.
      router.refresh()
    },
    [isOwnProfile, router]
  )

  // Escape closes, and the body stops scrolling behind the sheet.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, close])

  const label = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`

  return (
    <>
      <p className="ac-counts">
        {(['followers', 'following'] as Direction[]).map((dir) => {
          const text = dir === 'followers'
            ? label(counts.followers, 'follower', 'followers')
            : `${counts.following} following`

          return listsOpen ? (
            <button
              key={dir}
              type="button"
              className="ac-count-link"
              onClick={() => openList(dir)}
            >
              {text}
            </button>
          ) : (
            <span key={dir} className="ac-count-static">{text}</span>
          )
        })}
      </p>

      {open && (
        <div className="ac-sheet-backdrop" onClick={close}>
          <div
            className="ac-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={open === 'followers' ? 'Followers' : 'Following'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ac-sheet-head">
              <h2 className="ac-sheet-title">
                {open === 'followers' ? 'Followers' : 'Following'}
              </h2>
              <button type="button" className="ac-sheet-close" onClick={close} aria-label="Close">
                ×
              </button>
            </div>

            {error ? (
              <p className="ac-error">{error}</p>
            ) : people === null ? (
              <p className="ac-meta">Loading…</p>
            ) : people.length === 0 ? (
              <p className="ac-meta">
                {open === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}
              </p>
            ) : (
              <ul className="ac-people">
                {people.map((p) => (
                  <li className="ac-person" key={p.id}>
                    <Link className="ac-person-main" href={`/u/${p.username}`} onClick={close}>
                      {p.avatar_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img className="ac-avatar" src={p.avatar_url} alt="" />
                        : (
                          <div className="ac-avatar ac-avatar--placeholder">
                            {(p.display_name?.trim() || p.username).charAt(0).toUpperCase()}
                          </div>
                        )}
                      <span className="ac-person-names">
                        <span className="ac-person-name">
                          {p.display_name?.trim() || p.username}
                        </span>
                        <span className="ac-person-handle">@{p.username}</span>
                      </span>
                    </Link>

                    {/* Nothing at all on your own row: there is no version of
                        following, muting or blocking yourself, and the database
                        refuses all three. Everyone else gets a follow control —
                        signed-out visitors included, where it is a link through
                        sign-in rather than a dead name, the same as the button
                        on a profile page. The MENU stays signed-in only: mute
                        and block are decisions only an account can hold. */}
                    {viewerId !== p.id && (
                      <span className="ac-person-actions">
                        <FollowToggle
                          targetId={p.id}
                          targetUsername={p.username}
                          state={viewerId ? (followed.get(p.id) ?? 'none') : 'signed-out'}
                          onChanged={afterFollowChange(p.id, open)}
                          onNavigate={close}
                        />
                        {viewerId && (
                          <RelationshipMenu
                            targetId={p.id}
                            targetUsername={p.username}
                            muted={muted.has(p.id)}
                            /* Their follow of you exists, and is yours to
                               delete, only in your own followers list. */
                            canRemoveFollower={isOwnProfile && open === 'followers'}
                            onDone={afterAction(p.id)}
                          />
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  )
}
