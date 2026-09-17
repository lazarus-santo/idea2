import { getSupabase } from '@/lib/supabase'
import { profileDisplayName } from '@/lib/profile'

/**
 * Person search: profiles by username or display name.
 *
 * DELIBERATELY INDEPENDENT of the exhibition/reading/institution search in
 * app/api/search/route.ts. The two share a search box and nothing else — no
 * join, no shared query, no id from one side stored on the other. Exhibition
 * ids churn whenever Agent 1 rebuilds a venue, and identity (migration_v40) is
 * kept clear of that schema so it can never hold a reference that goes stale.
 * The route merges the two lists only as JSON for display.
 *
 * PRIVACY: only public profiles are returned, enforced twice.
 *   1. The query runs as `anon` with no session (getSupabase(), never the
 *      visitor's cookies and never the service role), so the RLS policy
 *      profiles_anon_read_public refuses every private and followers_only row.
 *      A signed-in visitor's own session would also return their OWN private
 *      profile — they would find themselves in search and conclude they are
 *      public.
 *   2. An explicit privacy = 'public' filter, so the rule survives if someone
 *      later swaps the client.
 * followers_only is excluded along with private, matching /u/[username]: it
 * reads as private until a follow graph exists.
 */

export interface UserResult {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  url: string
}

interface ProfileRow {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

const COLUMNS = 'id, username, display_name, avatar_url'

/** Fetch ceiling per field, before ranking. Ranking needs the exact match in hand. */
const FETCH_LIMIT = 50

/** Treat the query as literal text: % and _ are wildcards in ILIKE. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`)
}

/**
 * Exact username first, then names that start with the query, then everything
 * else — alphabetical by username within each band.
 */
function rank(rows: ProfileRow[], q: string): ProfileRow[] {
  const band = (r: ProfileRow) => {
    if (r.username === q) return 0
    if (r.username.startsWith(q) || (r.display_name ?? '').toLowerCase().startsWith(q)) return 1
    return 2
  }
  return [...rows].sort((a, b) => band(a) - band(b) || a.username.localeCompare(b.username))
}

/**
 * Never throws. A failure logs and returns [] so that a problem with profiles
 * cannot take exhibition search down with it (and vice versa in the route).
 */
export async function searchPeople(rawQuery: string, limit: number): Promise<UserResult[]> {
  // "@santo" should find santo.
  const q = rawQuery.trim().replace(/^@+/, '').toLowerCase()
  if (q.length < 2) return []

  const pattern = `%${escapeLike(q)}%`

  try {
    const sb = getSupabase()
    const base = () =>
      sb
        .from('profiles')
        .select(COLUMNS)
        .eq('privacy', 'public')
        .not('username', 'is', null)
        .limit(FETCH_LIMIT)

    // Two queries rather than one .or() string: user input containing commas
    // or parentheses would otherwise break the filter syntax.
    const [byUsername, byDisplayName] = await Promise.all([
      base().ilike('username', pattern),
      base().ilike('display_name', pattern),
    ])

    for (const res of [byUsername, byDisplayName]) {
      if (res.error) console.error('[search] people query failed:', res.error.message)
    }

    const seen = new Map<string, ProfileRow>()
    for (const row of [...(byUsername.data ?? []), ...(byDisplayName.data ?? [])] as ProfileRow[]) {
      if (!seen.has(row.id)) seen.set(row.id, row)
    }

    return rank([...seen.values()], q)
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        username: r.username,
        display_name: profileDisplayName(r),
        avatar_url: r.avatar_url,
        url: `/u/${r.username}`,
      }))
  } catch (err) {
    console.error('[search] people search threw:', err)
    return []
  }
}
