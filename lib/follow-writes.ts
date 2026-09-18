import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The three writes that change the follow graph, in one place.
 *
 * NOT server-only, on purpose — these run in the browser, straight against
 * Postgres under the policies in migration_v44, the same arrangement profile
 * edits use. lib/follows.ts is the other half: it READS the graph from the
 * server and says at its top that writes are not there. This is where they are.
 *
 * WHY A MODULE RATHER THAN THREE LINES IN EACH COMPONENT. Follow, unfollow and
 * remove-follower are one-liners, and by the time three components had a copy
 * each they would be one careless edit away from disagreeing about which
 * direction they delete — which is a security-relevant mistake, not a tidiness
 * one. `unfollow` and `removeFollower` differ ONLY in which column holds whose
 * id, and getting that backwards means a button labelled "remove this follower"
 * quietly unfollows them instead. Naming the two separately, once, is the
 * cheapest way to keep them apart.
 *
 * Every one of these is allowed by policy rather than by argument: RLS narrows
 * each statement to edges the caller is an end of, so passing somebody else's
 * id changes nothing about what the database will do.
 */

/** Who is following whom, as the database records it. */
export type FollowWriteResult = { error: { message: string } | null }

/**
 * Ask to follow, or follow outright.
 *
 * `status` IS DELIBERATELY NOT SENT. A trigger sets it from the TARGET's
 * privacy — 'approved' for a public account, 'pending' for a private one — and
 * the INSERT grant does not include the column, so a client that tried to claim
 * 'approved' against a private account would be refused rather than believed.
 * Callers read back what the database made of it instead of predicting it.
 *
 * A block between the two accounts makes this insert do nothing, silently and
 * without an error (migration_v48). That is why callers re-read rather than
 * assuming the follow took.
 */
export async function follow(
  supabase: SupabaseClient,
  me: string,
  targetId: string
): Promise<FollowWriteResult> {
  // Awaited rather than returned: a PostgREST builder is a thenable, not a
  // Promise, so handing it straight back would not satisfy the return type.
  return await supabase.from('follows').insert({ follower_id: me, followed_id: targetId })
}

/**
 * Stop following, or withdraw a request that has not been answered.
 *
 * One statement covers both: the row goes, whatever state it was in. YOUR edge
 * — follower_id is you.
 */
export async function unfollow(
  supabase: SupabaseClient,
  me: string,
  targetId: string
): Promise<FollowWriteResult> {
  return await supabase.from('follows').delete()
    .eq('follower_id', me)
    .eq('followed_id', targetId)
}

/**
 * Remove somebody from your followers.
 *
 * THEIR edge, pointing at you — the opposite direction from unfollow(), which
 * is the whole reason these are two functions and not one with a flag.
 *
 * Soft on purpose. They are not notified, nothing records that it happened, and
 * they may follow again immediately: straight back to 'approved' if you are
 * public, or a fresh 'pending' request if you are private. It is a "no thanks",
 * not the "never" that blocking is for.
 */
export async function removeFollower(
  supabase: SupabaseClient,
  me: string,
  followerId: string
): Promise<FollowWriteResult> {
  return await supabase.from('follows').delete()
    .eq('follower_id', followerId)
    .eq('followed_id', me)
}
