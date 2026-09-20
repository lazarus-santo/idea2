import type { SupabaseClient } from '@supabase/supabase-js'
import type { ReadingContentType } from '@/lib/reading-log-types'
import { parseContentKey } from '@/lib/top-four-types'

/**
 * The writes that change a Top Four, in one place.
 *
 * NOT server-only, on purpose — these run in the browser, the same arrangement
 * the logs, follows and profile edits use. lib/top-four.ts is the other half:
 * it READS from the server and says at its top that writes are not there.
 *
 * ── TWO WAYS IN, AND ONLY ONE OF THEM ACTUALLY WRITES ───────────────────────
 *
 * THE WHOLE LIST — saveTopFourExhibitions() / saveTopFourContent(). They send
 * the finished list, in order, because that is what the database accepts.
 * migration_v64 grants no INSERT, UPDATE or DELETE on either table to anybody
 * but service_role; the only way in is set_top_four_exhibitions() /
 * set_top_four_content(), which empty the list and lay the new order down
 * inside one transaction.
 *
 * That is not an inconvenience to work around. It is what makes a reorder
 * safe. The two constraints the feature rests on — one show per slot, one slot
 * per show — are precisely what a two-step swap violates in the middle: move
 * the thing in slot 2 up to slot 1 and, for an instant, two rows claim slot 1
 * and the write is refused halfway through. Sending the finished order means
 * there is no middle. The ORDER OF THE ARRAY IS THE RANKING: element 0 is
 * slot 1.
 *
 * ONE ITEM — addExhibitionToTopFour() and the three beside it. These exist
 * because the commonest thing anybody does is add the show they are looking at,
 * and making them restate the other three slots to do it would be asking them
 * to keep the books.
 *
 * THEY ARE NOT A SECOND WRITE PATH. The database functions behind them
 * (migration_v65) read the current list, apply the one change and call
 * migration_v64's whole-list function to write it. So a one-click add IS an
 * atomic whole-list replace — the composing just happens in Postgres instead
 * of here, where it cannot be got wrong by a caller that forgot to send a
 * slot. Nothing about the safety story changes; only who assembles the array.
 *
 * ── WHY THE EDITOR STILL HOLDS A DRAFT ──────────────────────────────────────
 *
 * Reordering is not one change, it is an arrangement, so the panel keeps a
 * draft and saves once. Writing on every ↑ would be four writes to move
 * something from fourth to first, three of which describe an order nobody
 * chose. Adding and removing are single decisions and write immediately.
 */

export type TopFourWriteResult = { error: { message: string } | null }

/**
 * Turn a database refusal into something a person can act on.
 *
 * The exception names are the contract, as in the log writers — matching on
 * prose would break the first time Postgres reworded anything.
 *
 * The two that matter are the eligibility refusals. They mean the editor
 * offered something the database then rejected, which is a bug rather than a
 * user mistake — most likely a list that went stale while it was open, because
 * the item was downgraded in another tab. The wording says what the rule is
 * and what to do, rather than blaming the person.
 */
function explain(message: string): string {
  if (message.includes('top_four_not_seen')) {
    return 'One of those shows is no longer marked as seen, so it cannot be in your Top Four. Reload and try again.'
  }
  if (message.includes('top_four_not_read')) {
    return 'One of those articles is no longer marked as read, so it cannot be in your Top Four. Reload and try again.'
  }
  if (message.includes('top_four_too_many')) {
    return 'A Top Four holds four at most.'
  }
  if (message.includes('top_four_duplicate')) {
    return 'The same item cannot take two slots.'
  }
  // The one refusal an ordinary person will actually meet. It is not a bug and
  // it does not blame them — it says what to do next.
  if (message.includes('top_four_full')) {
    return 'Your Top Four is full. Remove one to add another.'
  }
  // The foreign key, when a log row went away entirely rather than being
  // downgraded. Same story as the two above from the person's side.
  if (message.includes('top_four_exhibitions_logged')) {
    return 'One of those shows is no longer in your log, so it cannot be in your Top Four. Reload and try again.'
  }
  if (message.includes('top_four_content_logged')) {
    return 'One of those articles is no longer in your log, so it cannot be in your Top Four. Reload and try again.'
  }
  if (message.includes('not_signed_in')) {
    return 'Sign in to change your Top Four.'
  }
  return message
}

/**
 * Replace the exhibition Top Four with this list, in order.
 *
 * An empty array clears it. There is no user_id argument and there must never
 * be one: the function reads auth.uid() and writes the caller's own list, so
 * there is nothing here that could be pointed at somebody else.
 */
export async function saveTopFourExhibitions(
  supabase: SupabaseClient,
  exhibitionIds: string[]
): Promise<TopFourWriteResult> {
  const { error } = await supabase.rpc('set_top_four_exhibitions', {
    p_ids: exhibitionIds,
  })

  return { error: error ? { message: explain(error.message) } : null }
}

/**
 * Replace the article Top Four with this list, in order.
 *
 * Takes the editor's keys ('preread:<uuid>') and sends the pairs apart again,
 * because an article is identified by BOTH halves — the two tables have
 * independent id spaces. The function takes jsonb rather than two parallel
 * arrays so that the type and the id cannot arrive misaligned.
 */
export async function saveTopFourContent(
  supabase: SupabaseClient,
  keys: string[]
): Promise<TopFourWriteResult> {
  const items = keys.map((key) => {
    const { contentType, contentId } = parseContentKey(key)
    return { type: contentType, id: contentId }
  })

  const { error } = await supabase.rpc('set_top_four_content', {
    p_items: items,
  })

  return { error: error ? { message: explain(error.message) } : null }
}

/**
 * Put one show at the end of the Top Four.
 *
 * Refused with "your Top Four is full" at four — it never bumps anything to
 * make room, because a Top Four is nothing but choices and dropping one
 * without asking would throw a choice away.
 *
 * Adding a show that is already in the list does nothing and reports success,
 * which is the honest answer to a double-click: the thing the person wanted is
 * true either way.
 */
export async function addExhibitionToTopFour(
  supabase: SupabaseClient,
  exhibitionId: string
): Promise<TopFourWriteResult> {
  const { error } = await supabase.rpc('add_to_top_four_exhibition', {
    p_exhibition_id: exhibitionId,
  })

  return { error: error ? { message: explain(error.message) } : null }
}

/**
 * Take one show out, closing the gap behind it.
 *
 * NOT the same as un-logging the show. This says "it is not one of my four";
 * un-logging says "I never saw it", and that removes it from here as well,
 * through the foreign key.
 */
export async function removeExhibitionFromTopFour(
  supabase: SupabaseClient,
  exhibitionId: string
): Promise<TopFourWriteResult> {
  const { error } = await supabase.rpc('remove_from_top_four_exhibition', {
    p_exhibition_id: exhibitionId,
  })

  return { error: error ? { message: explain(error.message) } : null }
}

/** Put one article at the end of the Top Four. Takes the pair, never the id alone. */
export async function addContentToTopFour(
  supabase: SupabaseClient,
  contentType: ReadingContentType,
  contentId: string
): Promise<TopFourWriteResult> {
  const { error } = await supabase.rpc('add_to_top_four_content', {
    p_content_type: contentType,
    p_content_id: contentId,
  })

  return { error: error ? { message: explain(error.message) } : null }
}

/** Take one article out, closing the gap behind it. */
export async function removeContentFromTopFour(
  supabase: SupabaseClient,
  contentType: ReadingContentType,
  contentId: string
): Promise<TopFourWriteResult> {
  const { error } = await supabase.rpc('remove_from_top_four_content', {
    p_content_type: contentType,
    p_content_id: contentId,
  })

  return { error: error ? { message: explain(error.message) } : null }
}
