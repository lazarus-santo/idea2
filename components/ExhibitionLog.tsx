'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import { save as saveLog, remove as removeLog } from '@/lib/exhibition-log-writes'
import type {
  OwnExhibitionLog,
  LogStatus,
  CommentVisibility,
} from '@/lib/exhibition-logs'

/**
 * Logging one exhibition: mean to go, went, and what you thought.
 *
 * Writes straight to Postgres under the policies in migration_v62, the same
 * arrangement FollowButton uses, and refreshes rather than patching local
 * state — the entry is server-rendered from the same policies, so re-reading
 * it is both simpler and more honest than predicting what the database did.
 *
 * ── THE GATE IS THE DATABASE'S, NOT THIS COMPONENT'S ────────────────────────
 *
 * Rating, like and note appear only at 'seen', and the brief was explicit that
 * hiding them is not enough. It is not what enforces anything here either: a
 * CHECK constraint rejects the write, and lib/exhibition-log-writes.ts strips
 * the values before sending in any case. This component hides the controls for
 * the ordinary reason — they are meaningless on a show you have not been to —
 * and would be harmless if someone reached past it.
 *
 * ── WHY GOING BACK TO "WANT TO SEE" ASKS FIRST ──────────────────────────────
 *
 * It clears the rating, the like and the note, permanently. That is the right
 * default — 'want_to_see' means "I have not experienced this", and an opinion
 * kept in the dark alongside it would be a claim the person did not make — but
 * it is destructive and silent, so it gets a confirm. Only when there is
 * something to lose: on a bare 'seen' with no opinion attached, the toggle
 * just moves.
 *
 * ── WHAT SAVES IMMEDIATELY, AND WHAT DOES NOT ───────────────────────────────
 *
 * Status, rating and like are single decisions and write on click. The note is
 * typed, so it has a Save: a write per keystroke would be a write per
 * keystroke, and a note that saved on blur would save half-written thoughts.
 */
export default function ExhibitionLog({
  exhibitionId,
  exhibitionSlugTitle,
  viewerId,
  log,
}: {
  exhibitionId: string
  exhibitionSlugTitle: string
  viewerId: string | null
  log: OwnExhibitionLog | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seeded from the server row and then owned locally, because the note is a
  // draft until it is saved. The others write on click, so their local copy is
  // only ever briefly ahead of the database.
  const [rating, setRating] = useState<number | null>(log?.rating ?? null)
  const [liked, setLiked] = useState<boolean>(log?.liked ?? false)
  const [comment, setComment] = useState<string>(log?.comment ?? '')
  const [visibility, setVisibility] = useState<CommentVisibility>(
    log?.comment_visibility ?? 'public'
  )
  const [noteSaved, setNoteSaved] = useState(false)

  const status: LogStatus | null = log?.status ?? null
  const working = busy || pending

  if (!viewerId) {
    return (
      <div className="el-block">
        <p className="el-label">Your log</p>
        <Link
          className="el-signin"
          href={`/login?next=${encodeURIComponent(`/exhibitions/${exhibitionId}`)}`}
        >
          Sign in to log this show
        </Link>
      </div>
    )
  }

  const supabase = () => getSupabaseBrowser()

  async function run(action: () => Promise<{ error: { message: string } | null }>) {
    setBusy(true)
    setError(null)

    const { error } = await action()

    setBusy(false)
    if (error) {
      setError(error.message)
      // Refresh anyway: a refused write means this component and the database
      // disagree about the state of the row, and the database is right.
      router.refresh()
      return
    }

    startTransition(() => router.refresh())
  }

  /**
   * Write the whole log. Every caller passes the complete state — see the note
   * at the top of lib/exhibition-log-writes.ts for why a partial update would
   * fail exactly where it matters.
   */
  function write(next: {
    status: LogStatus
    rating: number | null
    liked: boolean
    comment: string
  }) {
    return run(() =>
      saveLog(supabase(), viewerId!, exhibitionId, {
        status: next.status,
        rating: next.rating,
        liked: next.liked,
        comment: next.comment,
        commentVisibility: visibility,
      })
    )
  }

  function markWantToSee() {
    const losing = rating !== null || liked || comment.trim().length > 0
    if (losing && !window.confirm(
      'Moving this back to Want to See clears your rating, like and note for this show. Continue?'
    )) return

    setRating(null)
    setLiked(false)
    setComment('')
    setNoteSaved(false)
    // Sent as a complete row, so the clearing is real rather than a hidden
    // leftover — and the CHECK would refuse it otherwise.
    return write({ status: 'want_to_see', rating: null, liked: false, comment: '' })
  }

  function markSeen() {
    return write({ status: 'seen', rating, liked, comment })
  }

  function chooseRating(value: number) {
    // Pressing the star you already chose clears the rating — otherwise a
    // mis-tap at 5 can only ever be moved, never taken back.
    const next = rating === value ? null : value
    setRating(next)
    return write({ status: 'seen', rating: next, liked, comment })
  }

  function toggleLiked() {
    const next = !liked
    setLiked(next)
    return write({ status: 'seen', rating, liked: next, comment })
  }

  async function saveNote() {
    setNoteSaved(false)
    await write({ status: 'seen', rating, liked, comment })
    setNoteSaved(true)
  }

  function unlog() {
    if (!window.confirm('Remove this show from your log? Your rating and note go with it.')) return
    setRating(null)
    setLiked(false)
    setComment('')
    return run(() => removeLog(supabase(), viewerId!, exhibitionId))
  }

  const noteChanged =
    comment.trim() !== (log?.comment ?? '') ||
    (comment.trim().length > 0 && visibility !== (log?.comment_visibility ?? 'public'))

  return (
    <div className="el-block">
      <p className="el-label">Your log</p>

      <div className="el-row">
        <button
          type="button"
          className={`el-choice${status === 'want_to_see' ? ' el-choice--on' : ''}`}
          onClick={markWantToSee}
          disabled={working}
          aria-pressed={status === 'want_to_see'}
          aria-label={`Mark ${exhibitionSlugTitle} as want to see`}
        >
          Want to see
        </button>
        <button
          type="button"
          className={`el-choice${status === 'seen' ? ' el-choice--on' : ''}`}
          onClick={markSeen}
          disabled={working}
          aria-pressed={status === 'seen'}
          aria-label={`Mark ${exhibitionSlugTitle} as seen`}
        >
          Seen
        </button>
        {status && (
          <button type="button" className="el-clear" onClick={unlog} disabled={working}>
            Remove
          </button>
        )}
      </div>

      {/* Only at 'seen'. The database refuses these values at 'want_to_see'
          whatever this component renders — see the note at the top. */}
      {status === 'seen' && (
        <div className="el-opinion">
          <div className="el-row">
            <div className="el-stars" role="group" aria-label="Your rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`el-star${rating !== null && n <= rating ? ' el-star--on' : ''}`}
                  onClick={() => chooseRating(n)}
                  disabled={working}
                  aria-label={
                    rating === n
                      ? `Clear your rating of ${n} out of 5`
                      : `Rate ${n} out of 5`
                  }
                >
                  ★
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`el-like${liked ? ' el-like--on' : ''}`}
              onClick={toggleLiked}
              disabled={working}
              aria-pressed={liked}
              aria-label={liked ? 'Remove your like' : 'Like this show'}
            >
              {liked ? 'Liked' : 'Like'}
            </button>
          </div>

          <textarea
            className="el-note"
            value={comment}
            onChange={(e) => { setComment(e.target.value); setNoteSaved(false) }}
            placeholder="A note about the show…"
            rows={3}
            aria-label="Your note about this show"
          />

          <div className="el-row el-row--note">
            {/* Named as who can read it, not as a setting. "Public" alone
                invites the reading that it escapes a private profile, which
                is exactly what it does not do — see migration_v62. */}
            <div className="el-visibility" role="group" aria-label="Who can read this note">
              <button
                type="button"
                className={`el-vis${visibility === 'public' ? ' el-vis--on' : ''}`}
                onClick={() => { setVisibility('public'); setNoteSaved(false) }}
                disabled={working}
                aria-pressed={visibility === 'public'}
              >
                Anyone who can see my profile
              </button>
              <button
                type="button"
                className={`el-vis${visibility === 'private' ? ' el-vis--on' : ''}`}
                onClick={() => { setVisibility('private'); setNoteSaved(false) }}
                disabled={working}
                aria-pressed={visibility === 'private'}
              >
                Only me
              </button>
            </div>

            <button
              type="button"
              className="el-save"
              onClick={saveNote}
              disabled={working || !noteChanged}
            >
              {working ? '…' : noteSaved && !noteChanged ? 'Saved' : 'Save note'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="el-error">{error}</p>}
    </div>
  )
}
