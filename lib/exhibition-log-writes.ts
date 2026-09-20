import type { SupabaseClient } from '@supabase/supabase-js'
import type { LogStatus, CommentVisibility } from '@/lib/exhibition-logs'

/**
 * The writes that change an exhibition log, in one place.
 *
 * NOT server-only, on purpose — these run in the browser, straight against
 * Postgres under the policies in migration_v62, the same arrangement follows
 * and profile edits use. lib/exhibition-logs.ts is the other half: it READS
 * from the server and says at its top that writes are not there.
 *
 * ── WHY save() ALWAYS SENDS EVERY COLUMN ────────────────────────────────────
 *
 * This is the whole clearing rule, and it is worth understanding before
 * editing anything below.
 *
 * migration_v62 has a CHECK that REJECTS a row holding a rating, a like or a
 * comment at status 'want_to_see'. It rejects rather than tidies, because a
 * write that quietly discarded a rating would leave the person believing they
 * had saved one.
 *
 * The consequence is that moving from 'seen' back to 'want_to_see' must carry
 * explicit nulls, or the existing values stay on the row and the CHECK fails.
 * Rather than have callers remember that, save() takes the WHOLE state of the
 * log every time and upserts a complete row. Going back to 'want_to_see'
 * therefore clears the rating, the like and the comment for real — they are
 * gone from the table, not preserved and hidden — which is the behaviour the
 * brief asked for, and the person is told it will happen before they do it.
 *
 * DO NOT "optimise" this into a partial update of the changed field. It would
 * work for every edit except the one that matters, and fail there with a
 * constraint violation nobody could act on.
 */

/** Everything a log row says. The complete state, which is what gets sent. */
export interface ExhibitionLogInput {
  status: LogStatus
  rating: number | null
  liked: boolean
  comment: string | null
  commentVisibility: CommentVisibility
}

export type LogWriteResult = { error: { message: string } | null }

/**
 * Turn a database refusal into something a person can act on.
 *
 * The constraint names are the contract here — matching on message text would
 * break the first time Postgres reworded anything. Each of these means the UI
 * and the database disagreed about what is allowed, which is a bug rather than
 * a user mistake, so the wording says what the rule is instead of blaming the
 * person.
 */
function explain(message: string): string {
  if (message.includes('exhibition_logs_seen_gates_opinions')) {
    return 'A rating, a like and a note can only go on a show you have marked as seen.'
  }
  if (message.includes('exhibition_logs_visibility_needs_comment')) {
    return 'A note has to be either public or private — it cannot be neither.'
  }
  if (message.includes('exhibition_logs_rating_range')) {
    return 'A rating has to be between 1 and 5.'
  }
  if (message.includes('no_such_exhibition')) {
    return 'That exhibition is not available to log.'
  }
  return message
}

/**
 * Save the log, creating it or replacing it.
 *
 * `comment_visibility` is sent as null whenever the comment is, because the
 * two travel together — a visibility with nothing to apply to is a row the
 * database refuses, and rightly: a stored comment with no visibility would
 * leave every reader to invent a default.
 *
 * The comment is trimmed and an empty one becomes null, so a person who types
 * into the box and deletes it again has no comment rather than a blank one.
 */
export async function save(
  supabase: SupabaseClient,
  me: string,
  exhibitionId: string,
  input: ExhibitionLogInput
): Promise<LogWriteResult> {
  const seen = input.status === 'seen'
  const comment = seen ? (input.comment?.trim() || null) : null

  const row = {
    user_id: me,
    exhibition_id: exhibitionId,
    status: input.status,
    // Gated client-side as well as in the database. Not because the client's
    // opinion counts — it does not, the CHECK is what enforces this — but
    // because sending values the database is about to reject would turn a
    // perfectly ordinary "actually, I have not been yet" into an error.
    rating: seen ? input.rating : null,
    liked: seen ? input.liked : false,
    comment,
    comment_visibility: comment ? input.commentVisibility : null,
  }

  // Awaited rather than returned: a PostgREST builder is a thenable, not a
  // Promise, so handing it straight back would not satisfy the return type.
  const { error } = await supabase
    .from('exhibition_logs')
    .upsert(row, { onConflict: 'user_id,exhibition_id' })

  return { error: error ? { message: explain(error.message) } : null }
}

/**
 * Remove the log entirely — not the same as marking it 'want_to_see'.
 *
 * 'want_to_see' is a statement ("I mean to go"). Deleting is the withdrawal of
 * any statement at all, and it is the only way to take back a comment someone
 * may already have read. RLS narrows this to your own row, so the user_id here
 * is a filter, not a permission.
 */
export async function remove(
  supabase: SupabaseClient,
  me: string,
  exhibitionId: string
): Promise<LogWriteResult> {
  const { error } = await supabase
    .from('exhibition_logs')
    .delete()
    .eq('user_id', me)
    .eq('exhibition_id', exhibitionId)

  return { error: error ? { message: explain(error.message) } : null }
}
