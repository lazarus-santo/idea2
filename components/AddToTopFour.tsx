'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import {
  addExhibitionToTopFour,
  removeExhibitionFromTopFour,
  addContentToTopFour,
  removeContentFromTopFour,
} from '@/lib/top-four-writes'
import type { ReadingContentType } from '@/lib/reading-log-types'
import '@/app/top-four.css'

/**
 * "Add to Top Four", on the log entry of the thing itself.
 *
 * One click, one item. The panel on the profile is still there and still owns
 * REORDERING, which is an arrangement rather than a single decision — but
 * adding the show you are standing in front of should not require restating
 * the other three slots, and this is that.
 *
 * ── IT IS STILL A WHOLE-LIST WRITE UNDERNEATH ───────────────────────────────
 *
 * add_to_top_four_exhibition() and its three siblings (migration_v65) read the
 * caller's current list, apply the one change and hand the finished list to
 * migration_v64's whole-list function. So nothing about the atomic replace,
 * the eligibility triggers or the constraint story changes here — see
 * lib/top-four-writes.ts. This component is a button on top of the same
 * guarantee.
 *
 * ── WHAT IT SHOWS, AND WHY THE FULL CASE IS NOT HIDDEN ──────────────────────
 *
 * Three states, and only the first two are visible before a click:
 *
 *   not in the list   "Add to Top Four".
 *   in the list       "In your Top Four", with Remove beside it.
 *   full             the SAME "Add to Top Four" button, which on click comes
 *                    back with "Your Top Four is full. Remove one to add
 *                    another."
 *
 * The full case deliberately does not hide or disable the button. A control
 * that vanishes teaches nobody why, and a disabled one invites guessing. The
 * message is also not predicted here: the button always attempts the write and
 * reports what the DATABASE said. That costs one round trip and buys the only
 * answer that is never stale — if the person freed a slot in another tab, this
 * add simply succeeds instead of refusing on a count this component was
 * holding from a minute ago.
 *
 * ── ELIGIBILITY IS THE CALLER'S TO DECIDE ───────────────────────────────────
 *
 * This renders nothing of its own accord. The log widgets show it only once
 * the item is marked seen/read, because offering it earlier would be offering
 * an error. As everywhere else in this feature, that is courtesy and not the
 * gate: the database refuses a write for anything unlogged whatever this
 * component believes.
 */

export type TopFourTarget =
  | { kind: 'exhibition'; exhibitionId: string }
  | { kind: 'content'; contentType: ReadingContentType; contentId: string }

export default function AddToTopFour({
  target,
  inTopFour,
  onChanged,
}: {
  target: TopFourTarget
  /** Whether this item is already one of the four. */
  inTopFour: boolean
  /**
   * Client pages with no server render to refresh pass this, exactly as
   * ReadingLog's onSaved does. Omitted, the component calls router.refresh()
   * and the state comes back from the same read that drew it.
   */
  onChanged?: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const working = busy || pending

  async function run(add: boolean) {
    setBusy(true)
    setError(null)

    const supabase = getSupabaseBrowser()
    const { error } =
      target.kind === 'exhibition'
        ? add
          ? await addExhibitionToTopFour(supabase, target.exhibitionId)
          : await removeExhibitionFromTopFour(supabase, target.exhibitionId)
        : add
          ? await addContentToTopFour(supabase, target.contentType, target.contentId)
          : await removeContentFromTopFour(supabase, target.contentType, target.contentId)

    setBusy(false)

    if (error) {
      setError(error.message)
      return
    }

    if (onChanged) onChanged()
    else startTransition(() => router.refresh())
  }

  return (
    <div className="tf-action">
      {inTopFour ? (
        <>
          <span className="tf-action-in">In your Top Four</span>
          <button
            type="button"
            className="tf-action-btn"
            onClick={() => run(false)}
            disabled={working}
          >
            {working ? '…' : 'Remove'}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="tf-action-btn"
          onClick={() => run(true)}
          disabled={working}
        >
          {working ? 'Saving…' : 'Add to Top Four'}
        </button>
      )}

      {/* The full message lands here, under the button that caused it, rather
          than anywhere a person would have to go looking. */}
      {error && <span className="tf-action-error">{error}</span>}
    </div>
  )
}
