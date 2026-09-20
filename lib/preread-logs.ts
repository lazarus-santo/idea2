/**
 * Has anyone logged this preread?
 *
 * The logging feature (seen it, rated it, short review — for exhibitions and
 * readings alike) is not built yet, so there is no table to ask. Nothing has
 * been logged, and every answer here is `false`.
 *
 * It exists as one module anyway, because the rule it feeds — a logged row is
 * frozen, never overwritten (migration_v61) — has to be written into the repair
 * and fair-regeneration paths NOW, while they are being touched, not bolted on
 * afterwards when the logging feature ships and someone has to remember every
 * place a preread gets rewritten.
 *
 * ── WIRING IT UP ────────────────────────────────────────────────────────────
 * When the log table lands, this is the only file that changes: replace the
 * body of loggedPrereadIds with one query, something like
 *
 *     const { data, error } = await getSupabaseAdmin()
 *       .from('<the log table>')
 *       .select('preread_id')
 *       .in('preread_id', prereadIds)
 *     if (error) throw new Error(`Failed to read preread logs: ${error.message}`)
 *     return new Set((data ?? []).map((r) => r.preread_id as string))
 *
 * Throw on a read failure rather than returning an empty set: "I could not
 * check" must never be treated as "nobody logged it", or a database hiccup
 * turns into an overwritten log.
 */

/**
 * Test seam, not a feature. A comma-separated list of preread ids to treat as
 * logged, so the freeze path can be exercised end to end before the log table
 * exists:
 *
 *     PREREAD_LOG_STUB_IDS=<preread-uuid> npm run dev
 *
 * Unset in production, where it reads as "nothing is logged" — the truth today.
 */
const STUB_ENV = 'PREREAD_LOG_STUB_IDS'

function stubbedIds(): Set<string> {
  const raw = process.env[STUB_ENV]
  if (!raw) return new Set()
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

/** Which of `prereadIds` a person has logged. One query's worth, for callers holding many rows. */
export async function loggedPrereadIds(prereadIds: string[]): Promise<Set<string>> {
  if (prereadIds.length === 0) return new Set()
  const stub = stubbedIds()
  if (stub.size === 0) return new Set()
  return new Set(prereadIds.filter((id) => stub.has(id)))
}

/** Has this one preread been logged? */
export async function isPrereadLogged(prereadId: string): Promise<boolean> {
  return (await loggedPrereadIds([prereadId])).has(prereadId)
}
