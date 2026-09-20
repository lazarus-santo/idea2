import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  ReadingLogStatus,
  CommentVisibility,
  ReadingContentType,
} from '@/lib/reading-log-types'

/**
 * The writes that change a reading log, in one place.
 *
 * NOT server-only, on purpose — these run in the browser, straight against
 * Postgres under the policies in migration_v63, the same arrangement the
 * exhibition log, follows and profile edits use. lib/reading-logs.ts is the
 * other half: it READS from the server and says at its top that writes are not
 * there.
 *
 * ── WHY save() ALWAYS SENDS EVERY COLUMN ────────────────────────────────────
 *
 * The same rule as lib/exhibition-log-writes.ts, and worth re-reading before
 * editing anything below.
 *
 * migration_v63 has a CHECK that REJECTS a row holding a rating, a like or a
 * note at status 'reading_list'. It rejects rather than tidies, because a
 * write that quietly discarded a rating would leave the person believing they
 * had saved one.
 *
 * The consequence is that moving from 'read' back to 'reading_list' must carry
 * explicit nulls, or the existing values stay on the row and the CHECK fails.
 * Rather than have callers remember that, save() takes the WHOLE state every
 * time and upserts a complete row. Going back to 'reading_list' therefore
 * clears the rating, the like and the note for real — gone from the table, not
 * preserved and hidden — which is the behaviour the brief asked for, and the
 * person is warned before it happens.
 *
 * DO NOT "optimise" this into a partial update of the changed field. It would
 * work for every edit except the one that matters, and fail there with a
 * constraint violation nobody could act on.
 */

/** Everything a reading log row says. The complete state, which is what gets sent. */
export interface ReadingLogInput {
  status: ReadingLogStatus
  rating: number | null
  liked: boolean
  comment: string | null
  commentVisibility: CommentVisibility
}

export type ReadingLogWriteResult = { error: { message: string } | null }

/**
 * Turn a database refusal into something a person can act on.
 *
 * The constraint names are the contract — matching on message text would break
 * the first time Postgres reworded anything. Each of these means the UI and
 * the database disagreed about what is allowed, which is a bug rather than a
 * user mistake, so the wording says what the rule is instead of blaming the
 * person.
 */
function explain(message: string): string {
  if (message.includes('reading_logs_read_gates_opinions')) {
    return 'A rating, a like and a note can only go on something you have marked as read.'
  }
  if (message.includes('reading_logs_visibility_needs_comment')) {
    return 'A note has to be either public or private — it cannot be neither.'
  }
  if (message.includes('reading_logs_rating_range')) {
    return 'A rating has to be between 1 and 5.'
  }
  if (message.includes('no_such_content')) {
    return 'That article is not available to log.'
  }
  return message
}

/**
 * Save the log, creating it or replacing it.
 *
 * `comment_visibility` is sent as null whenever the comment is, because the
 * two travel together — a visibility with nothing to apply to is a row the
 * database refuses, and rightly: a stored note with no visibility would leave
 * every reader to invent a default.
 *
 * The note is trimmed and an empty one becomes null, so a person who types
 * into the box and deletes it again has no note rather than a blank one.
 */
export async function save(
  supabase: SupabaseClient,
  me: string,
  contentType: ReadingContentType,
  contentId: string,
  input: ReadingLogInput
): Promise<ReadingLogWriteResult> {
  const read = input.status === 'read'
  const comment = read ? (input.comment?.trim() || null) : null

  const row = {
    user_id: me,
    content_type: contentType,
    content_id: contentId,
    status: input.status,
    // Gated client-side as well as in the database. Not because the client's
    // opinion counts — the CHECK is what enforces this — but because sending
    // values the database is about to reject would turn a perfectly ordinary
    // "actually, I have not read it yet" into an error.
    rating: read ? input.rating : null,
    liked: read ? input.liked : false,
    comment,
    comment_visibility: comment ? input.commentVisibility : null,
  }

  // Awaited rather than returned: a PostgREST builder is a thenable, not a
  // Promise, so handing it straight back would not satisfy the return type.
  const { error } = await supabase
    .from('reading_logs')
    .upsert(row, { onConflict: 'user_id,content_type,content_id' })

  return { error: error ? { message: explain(error.message) } : null }
}

/**
 * Remove the log entirely — not the same as marking it 'reading_list'.
 *
 * 'reading_list' is a statement ("I mean to read this"). Deleting is the
 * withdrawal of any statement at all, and it is the only way to take back a
 * note somebody may already have read. RLS narrows this to your own row, so
 * the user_id here is a filter, not a permission.
 */
export async function remove(
  supabase: SupabaseClient,
  me: string,
  contentType: ReadingContentType,
  contentId: string
): Promise<ReadingLogWriteResult> {
  const { error } = await supabase
    .from('reading_logs')
    .delete()
    .eq('user_id', me)
    .eq('content_type', contentType)
    .eq('content_id', contentId)

  return { error: error ? { message: explain(error.message) } : null }
}
