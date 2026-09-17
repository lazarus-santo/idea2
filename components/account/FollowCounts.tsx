'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import type { FollowCounts as Counts, FollowPerson } from '@/lib/follows'

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
 */
export default function FollowCounts({
  profileId,
  counts,
  listsOpen,
}: {
  profileId: string
  counts: Counts
  listsOpen: boolean
}) {
  const [open, setOpen] = useState<Direction | null>(null)
  const [people, setPeople] = useState<FollowPerson[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const requestRef = useRef(0)

  const close = useCallback(() => {
    // Bumping the ticket abandons any list still loading, so it cannot land in
    // a sheet the person has already dismissed.
    requestRef.current++
    setOpen(null)
    setPeople(null)
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

    const fn = direction === 'followers' ? 'profile_followers' : 'profile_following'
    const { data, error } = await getSupabaseBrowser()
      .rpc(fn, { profile_id: profileId })

    if (ticket !== requestRef.current) return

    if (error) {
      console.error('[follows] list failed:', error.message)
      setError('That list could not be loaded.')
      return
    }
    setPeople((data ?? []) as FollowPerson[])
  }

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
