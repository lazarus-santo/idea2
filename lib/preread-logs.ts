import { getSupabaseAdmin } from './supabase'

/**
 * Has anyone logged this preread?
 *
 * This is the question the freeze rule turns on. migration_v61 says a preread
 * row someone has logged is never overwritten: repair and the admin Replace
 * button put the fresh article into a NEW row and freeze the logged one —
 * blanked, content untouched, pointing at its replacement — so the log still
 * resolves to the article the person actually read.
 *
 * ── THIS FILE WAS A STUB UNTIL migration_v63 ────────────────────────────────
 *
 * It shipped with e10444b answering `false` to everything, because there was
 * no log table to ask. That was honest at the time — nothing WAS logged — but
 * it meant the freeze mechanism existed without the protection: every repair
 * took the overwrite path, unconditionally. migration_v63 created
 * public.reading_logs, and this now asks it. The freeze is live from here.
 *
 * ── WHY THE ADMIN CLIENT, AND WHY IT THROWS ─────────────────────────────────
 *
 * The service key, because this asks whether ANYBODY logged the row, and
 * reading_logs is first-person under RLS — a session-scoped read would answer
 * only for one account and miss every other person's log. The callers (Agent 2
 * repair, the admin Replace route, fair coverage regeneration) are all
 * server-side and already hold it.
 *
 * It THROWS on a read failure rather than returning an empty set, and that is
 * the whole reason this is a function and not an inline query. "I could not
 * check" must never be treated as "nobody logged it": the empty-set answer
 * sends the caller down the overwrite path, and a momentary database hiccup
 * would silently rewrite the article under somebody's rating. Failing the
 * repair is the recoverable outcome; overwriting a log is not.
 */

/** Which of `prereadIds` anyone has logged. One query's worth, for callers holding many rows. */
export async function loggedPrereadIds(prereadIds: string[]): Promise<Set<string>> {
  if (prereadIds.length === 0) return new Set()

  const { data, error } = await getSupabaseAdmin()
    .from('reading_logs')
    .select('content_id')
    .eq('content_type', 'preread')
    .in('content_id', prereadIds)

  // Never swallowed. See above: an empty set here means "overwrite it".
  if (error) throw new Error(`Failed to read preread logs: ${error.message}`)

  return new Set((data ?? []).map((r) => r.content_id as string))
}

/** Has this one preread been logged? */
export async function isPrereadLogged(prereadId: string): Promise<boolean> {
  return (await loggedPrereadIds([prereadId])).has(prereadId)
}
