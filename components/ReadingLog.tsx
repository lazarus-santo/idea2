'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import { save as saveLog, remove as removeLog } from '@/lib/reading-log-writes'
import AddToTopFour from '@/components/AddToTopFour'
import type {
  OwnReadingLog,
  ReadingLogStatus,
  CommentVisibility,
  ReadingContentType,
} from '@/lib/reading-log-types'
import '@/app/exhibition-log.css'
import '@/app/reading-log.css'

/**
 * Logging one thing you read: mean to read it, read it, and what you thought.
 *
 * The reading counterpart of ExhibitionLog, and deliberately the same
 * component in every way that matters — the same gate, the same confirm before
 * a destructive downgrade, the same "status writes on click, the note has a
 * Save". If you are changing behaviour here, change it there too.
 *
 * ── THE GATE IS THE DATABASE'S, NOT THIS COMPONENT'S ────────────────────────
 *
 * Rating, like and note appear only at 'read', and the brief was explicit that
 * hiding them is not enough. It is not what enforces anything here either: a
 * CHECK constraint in migration_v63 rejects the write, and
 * lib/reading-log-writes.ts strips the values before sending in any case. This
 * hides the controls for the ordinary reason — they are meaningless on
 * something you have not read — and would be harmless if someone reached past
 * it.
 *
 * ── TWO SHAPES, ONE SET OF CONTROLS ─────────────────────────────────────────
 *
 * `variant` changes where the controls sit, never what they are:
 *
 *   'full'      the block ExhibitionLog renders, for a page about one article
 *               (/readings/[id]).
 *   'compact'   a single pill that opens the same block in a small panel, for
 *               the places an article is one row or one card among many — the
 *               preread list on an exhibition page, the River, Top Stories.
 *
 * Compact exists because those surfaces have no room. The Top Stories layouts
 * are absolutely positioned to a design's measurements, with fixed text blocks
 * that clip; the River is a dense one-line-per-article list. Anything that
 * added height to a row would either be cut off or push the layout apart, so
 * the pill floats and the panel opens over what is beside it.
 *
 * ── HOW IT REFRESHES ────────────────────────────────────────────────────────
 *
 * On a server-rendered page (`onSaved` omitted) it calls router.refresh() and
 * the entry comes back from the same policies that wrote it. On the Readings
 * page there is no server render to refresh, so the caller passes `onSaved`
 * and re-reads the log store instead. Both re-read rather than patching local
 * state: the database is the thing that decided, and predicting what it did is
 * how the two drift apart.
 */
export default function ReadingLog({
  contentType,
  contentId,
  title,
  viewerId,
  log,
  variant = 'full',
  signInNext,
  onSaved,
  inTopFour = false,
}: {
  contentType: ReadingContentType
  contentId: string
  /** What this is, for the screen-reader labels. The headline or article title. */
  title: string
  viewerId: string | null
  log: OwnReadingLog | null
  variant?: 'full' | 'compact'
  /** Where to come back to after signing in. */
  signInNext: string
  /** Client pages pass this instead of relying on router.refresh(). */
  onSaved?: () => void
  /**
   * Whether this article is already one of the viewer's four. Only ever used
   * to choose between Add and Remove — the database decides what is allowed.
   */
  inTopFour?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  // Seeded from the stored row and then owned locally, because the note is a
  // draft until it is saved. The others write on click, so their local copy is
  // only ever briefly ahead of the database.
  const [rating, setRating] = useState<number | null>(log?.rating ?? null)
  const [liked, setLiked] = useState<boolean>(log?.liked ?? false)
  const [comment, setComment] = useState<string>(log?.comment ?? '')
  const [visibility, setVisibility] = useState<CommentVisibility>(
    log?.comment_visibility ?? 'public'
  )
  const [noteSaved, setNoteSaved] = useState(false)

  const status: ReadingLogStatus | null = log?.status ?? null
  const working = busy || pending

  if (!viewerId) {
    // Compact has no room for a sentence, and a pill that only ever says "sign
    // in" on every row would be noise. The whole control is left out instead.
    if (variant === 'compact') return null
    return (
      <div className="el-block">
        <p className="el-label">Your log</p>
        <Link className="el-signin" href={`/login?next=${encodeURIComponent(signInNext)}`}>
          Sign in to log this
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
      // Re-read anyway: a refused write means this component and the database
      // disagree about the state of the row, and the database is right.
      if (onSaved) onSaved()
      else router.refresh()
      return
    }

    if (onSaved) onSaved()
    else startTransition(() => router.refresh())
  }

  /**
   * Write the whole log. Every caller passes the complete state — see the note
   * at the top of lib/reading-log-writes.ts for why a partial update would
   * fail exactly where it matters.
   */
  function write(next: {
    status: ReadingLogStatus
    rating: number | null
    liked: boolean
    comment: string
  }) {
    return run(() =>
      saveLog(supabase(), viewerId!, contentType, contentId, {
        status: next.status,
        rating: next.rating,
        liked: next.liked,
        comment: next.comment,
        commentVisibility: visibility,
      })
    )
  }

  /**
   * Back to the reading list, which clears the rating, the like and the note
   * permanently.
   *
   * That is the right default — 'reading_list' means "I have not read this",
   * and an opinion kept in the dark alongside it would be a claim the person
   * did not make — but it is destructive and silent, so it asks first. Only
   * when there is something to lose: on a bare 'read' the toggle just moves.
   */
  function markReadingList() {
    const losing = rating !== null || liked || comment.trim().length > 0
    if (losing && !window.confirm(
      'Moving this back to your reading list clears your rating, like and note for it. Continue?'
    )) return

    setRating(null)
    setLiked(false)
    setComment('')
    setNoteSaved(false)
    // Sent as a complete row, so the clearing is real rather than a hidden
    // leftover — and the CHECK would refuse it otherwise.
    return write({ status: 'reading_list', rating: null, liked: false, comment: '' })
  }

  function markRead() {
    // Opening the panel on the click that marks it read saves a second click
    // for the thing people came to do: say what they thought.
    if (variant === 'compact') setOpen(true)
    return write({ status: 'read', rating, liked, comment })
  }

  function chooseRating(value: number) {
    // Pressing the star you already chose clears the rating — otherwise a
    // mis-tap at 5 can only ever be moved, never taken back.
    const next = rating === value ? null : value
    setRating(next)
    return write({ status: 'read', rating: next, liked, comment })
  }

  function toggleLiked() {
    const next = !liked
    setLiked(next)
    return write({ status: 'read', rating, liked: next, comment })
  }

  async function saveNote() {
    setNoteSaved(false)
    await write({ status: 'read', rating, liked, comment })
    setNoteSaved(true)
  }

  function unlog() {
    if (!window.confirm('Remove this from your log? Your rating and note go with it.')) return
    setRating(null)
    setLiked(false)
    setComment('')
    return run(() => removeLog(supabase(), viewerId!, contentType, contentId))
  }

  const noteChanged =
    comment.trim() !== (log?.comment ?? '') ||
    (comment.trim().length > 0 && visibility !== (log?.comment_visibility ?? 'public'))

  const controls = (
    <>
      <div className="el-row">
        <button
          type="button"
          className={`el-choice${status === 'reading_list' ? ' el-choice--on' : ''}`}
          onClick={markReadingList}
          disabled={working}
          aria-pressed={status === 'reading_list'}
          aria-label={`Add ${title} to your reading list`}
        >
          Reading list
        </button>
        <button
          type="button"
          className={`el-choice${status === 'read' ? ' el-choice--on' : ''}`}
          onClick={markRead}
          disabled={working}
          aria-pressed={status === 'read'}
          aria-label={`Mark ${title} as read`}
        >
          Read
        </button>
        {status && (
          <button type="button" className="el-clear" onClick={unlog} disabled={working}>
            Remove
          </button>
        )}
      </div>

      {/* Only at 'read'. The database refuses these values at 'reading_list'
          whatever this component renders — see the note at the top. */}
      {status === 'read' && (
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
              aria-label={liked ? 'Remove your like' : 'Like this'}
            >
              {liked ? 'Liked' : 'Like'}
            </button>
          </div>

          <textarea
            className="el-note"
            value={comment}
            onChange={(e) => { setComment(e.target.value); setNoteSaved(false) }}
            placeholder="A note about what you read…"
            rows={3}
            aria-label="Your note about this"
          />

          <div className="el-row el-row--note">
            {/* Named as who can read it, not as a setting. "Public" alone
                invites the reading that it escapes a private profile, which is
                exactly what it does not do — see migration_v63. */}
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

          {/* Inside the 'read' block, so it appears exactly when the article
              becomes eligible and goes away when it stops being — the same
              moment the downgrade trigger removes it from the Top Four. It
              shares onSaved with the log itself: on the Readings page there is
              no server render to refresh, so both re-read the same store. */}
          <AddToTopFour
            target={{ kind: 'content', contentType, contentId }}
            inTopFour={inTopFour}
            onChanged={onSaved}
          />
        </div>
      )}

      {error && <p className="el-error">{error}</p>}
    </>
  )

  if (variant === 'full') {
    return (
      <div className="el-block">
        <p className="el-label">Your log</p>
        {controls}
      </div>
    )
  }

  // The pill says the state rather than an instruction, the same way the
  // toggles inside it do. Unlogged it invites the action; logged it reports.
  const pillLabel = status === 'read' ? 'Read' : status === 'reading_list' ? 'Saved' : 'Log'

  return (
    <div className="rl-compact">
      <button
        type="button"
        className={`rl-pill${status ? ' rl-pill--on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Log ${title}`}
      >
        {pillLabel}
      </button>

      {open && (
        <div className="rl-panel">
          <div className="rl-panel-head">
            <span className="el-label">Your log</span>
            <button
              type="button"
              className="rl-close"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          {controls}
        </div>
      )}
    </div>
  )
}
