import { getSupabase } from '@/lib/supabase'
import { PROFILE_CARD_COLUMNS, profileDisplayName, type ProfileCard } from '@/lib/profile'

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
 * PRIVACY: every profile is searchable, private ones included.
 *
 * This reversed in v43. The first version filtered private profiles out, which
 * sounded careful and was the wrong place to draw the line: you cannot ask to
 * follow an account you are unable to find, so hiding private accounts from
 * search made a private account useless rather than protected. Privacy gates
 * the profile PAGE — /u/[username] shows a locked state instead of content —
 * and search is how someone gets there to ask.
 *
 * What protects a private profile here is the source: public.profile_cards, a
 * view holding only id, username, display_name, avatar_url and privacy. Bio
 * never comes back from it, for any profile, because the view does not select
 * it. public.profiles itself is untouched and still owner-only for a private
 * row.
 *
 * Still queried as `anon` with no session (getSupabase(), never the visitor's
 * cookies and never the service role). The view returns the same rows to
 * everyone, so a session would change nothing — but reaching for one would
 * invite the service role in later, and that WOULD change something.
 */

export interface UserResult {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  url: string
}

/** A row of public.profile_cards. username is non-null — the view filters. */
type ProfileRow = ProfileCard & { username: string }

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
        .from('profile_cards')
        .select(PROFILE_CARD_COLUMNS)
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
