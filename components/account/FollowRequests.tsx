'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import type { PendingRequest } from '@/lib/follows'

/**
 * The approval queue: who has asked to follow you, with approve and deny.
 *
 * Only ever rendered on your own profile, and the rows only ever reach the
 * browser through pending_follow_requests(), which answers for the caller and
 * takes no account id — so there is no version of this component that can be
 * pointed at somebody else's queue.
 *
 * DENY DELETES THE ROW rather than recording a refusal. A stored 'denied' state
 * would quietly bar that person from ever asking again — a block, which is a
 * different feature with different expectations, arrived at by accident. Gone
 * means they may ask again later, and it means this table never accumulates a
 * list of people you turned down.
 *
 * KNOWN GAP: nobody is told any of this happened. There is no notification
 * system in this database, so a request arrives silently and an approval is
 * discovered by going back and looking. Building one was out of scope; it is
 * the obvious next thing this feature wants.
 */
export default function FollowRequests({ requests }: { requests: PendingRequest[] }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (requests.length === 0) return null

  async function act(requesterId: string, decision: 'approve' | 'deny') {
    setBusyId(requesterId)
    setError(null)

    const supabase = getSupabaseBrowser()
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) {
      setError('Sign in again to answer this.')
      setBusyId(null)
      return
    }

    // Both statements are scoped to rows where YOU are the one being followed,
    // which is also the only thing the policies would permit.
    const { error } =
      decision === 'approve'
        ? await supabase
            .from('follows')
            .update({ status: 'approved' })
            .eq('follower_id', requesterId)
            .eq('followed_id', auth.user.id)
        : await supabase
            .from('follows')
            .delete()
            .eq('follower_id', requesterId)
            .eq('followed_id', auth.user.id)

    if (error) {
      setError(error.message)
      setBusyId(null)
      return
    }

    setBusyId(null)
    router.refresh()
  }

  return (
    <section className="ac-section">
      <h2 className="ac-section-title">
        Follow requests ({requests.length})
      </h2>

      <ul className="ac-people">
        {requests.map((r) => (
          <li className="ac-person" key={r.id}>
            <Link className="ac-person-main" href={`/u/${r.username}`}>
              {r.avatar_url
                // eslint-disable-next-line @next/next/no-img-element
                ? <img className="ac-avatar" src={r.avatar_url} alt="" />
                : (
                  <div className="ac-avatar ac-avatar--placeholder">
                    {(r.display_name?.trim() || r.username).charAt(0).toUpperCase()}
                  </div>
                )}
              <span className="ac-person-names">
                <span className="ac-person-name">{r.display_name?.trim() || r.username}</span>
                <span className="ac-person-handle">@{r.username}</span>
              </span>
            </Link>

            <span className="ac-person-actions">
              <button
                type="button"
                className="ac-btn ac-btn--inline ac-btn--small"
                onClick={() => act(r.id, 'approve')}
                disabled={busyId === r.id}
              >
                {busyId === r.id ? '…' : 'Approve'}
              </button>
              <button
                type="button"
                className="ac-btn ac-btn--secondary ac-btn--inline ac-btn--small"
                onClick={() => act(r.id, 'deny')}
                disabled={busyId === r.id}
              >
                Deny
              </button>
            </span>
          </li>
        ))}
      </ul>

      {error && <p className="ac-error">{error}</p>}
    </section>
  )
}
