'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import type { FollowRelationship } from '@/lib/follows'

/**
 * Follow, cancel a request, or unfollow.
 *
 * Writes straight to Postgres under the policies in migration_v44, the same
 * arrangement profile edits use. Two things this component deliberately does
 * NOT decide:
 *
 *   * whether a follow lands as pending or approved. It inserts the pair and
 *     reads back what the database made of it. A trigger sets status from the
 *     TARGET's privacy, and the INSERT grant does not even include the column,
 *     so a client that tried to claim 'approved' against a private account
 *     would be refused rather than believed.
 *   * whether the viewer may see the profile. That is the page's job, decided
 *     by a fresh server read.
 *
 * Which is why every successful write ends in router.refresh(): the counts, the
 * locked state and the approval queue are all server-rendered from the same
 * policies, and re-rendering them is both simpler and more honest than patching
 * local state to say what we hope the database did.
 */
export default function FollowButton({
  targetId,
  targetUsername,
  relationship,
}: {
  targetId: string
  targetUsername: string
  relationship: FollowRelationship
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Your own profile gets an Edit link from the page, not a follow button.
  if (relationship === 'self') return null

  // Signed out: the database would refuse the insert, so ask them to sign in
  // first and send them back to the profile they were looking at.
  if (relationship === 'signed-out') {
    return (
      <Link
        className="ac-btn ac-btn--inline"
        href={`/login?next=${encodeURIComponent(`/u/${targetUsername}`)}`}
      >
        Follow
      </Link>
    )
  }

  const working = busy || pending

  async function run(action: () => Promise<{ error: { message: string } | null }>) {
    setBusy(true)
    setError(null)

    const { error } = await action()

    if (error) {
      // 23505 is the primary key: a row for this pair already exists, which
      // means the graph moved under us (another tab, or a double click that
      // beat the disabled state). A refresh shows what is actually there.
      setError(error.message.includes('duplicate key') ? null : error.message)
      setBusy(false)
      router.refresh()
      return
    }

    setBusy(false)
    startTransition(() => router.refresh())
  }

  const supabase = () => getSupabaseBrowser()

  const follow = () =>
    run(async () => {
      const { data: auth } = await supabase().auth.getUser()
      if (!auth.user) return { error: { message: 'Sign in to follow people.' } }

      // status is omitted on purpose — see the note at the top.
      return supabase()
        .from('follows')
        .insert({ follower_id: auth.user.id, followed_id: targetId })
    })

  // One statement covers unfollowing and cancelling a request: the row goes,
  // whatever state it was in. RLS narrows the match to this person's own edge.
  const unfollow = () =>
    run(async () => {
      const { data: auth } = await supabase().auth.getUser()
      if (!auth.user) return { error: { message: 'Sign in to follow people.' } }

      return supabase()
        .from('follows')
        .delete()
        .eq('follower_id', auth.user.id)
        .eq('followed_id', targetId)
    })

  const label =
    relationship === 'approved' ? 'Following'
    : relationship === 'pending' ? 'Requested'
    : 'Follow'

  // Requested and Following are both "press to undo", so they read as the
  // current state rather than as an instruction, and both are secondary.
  const secondary = relationship !== 'none'

  return (
    <div className="ac-follow">
      <button
        type="button"
        className={`ac-btn ac-btn--inline${secondary ? ' ac-btn--secondary' : ''}`}
        onClick={relationship === 'none' ? follow : unfollow}
        disabled={working}
        aria-label={
          relationship === 'approved' ? `Unfollow @${targetUsername}`
          : relationship === 'pending' ? `Cancel your follow request to @${targetUsername}`
          : `Follow @${targetUsername}`
        }
      >
        {working ? '…' : label}
      </button>
      {error && <p className="ac-error ac-follow-error">{error}</p>}
    </div>
  )
}
