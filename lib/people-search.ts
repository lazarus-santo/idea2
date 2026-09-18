import 'server-only'

import { getSupabaseServer } from '@/lib/supabase-server'
import { profileDisplayName, type ProfileCard } from '@/lib/profile'

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
 * What protects a private profile here is the source: public.search_profile_cards,
 * a SECURITY DEFINER function whose RETURNS TABLE names five columns — id,
 * username, display_name, avatar_url, privacy. Bio is not among them, for any
 * profile, so it cannot come back however this is called. public.profiles
 * itself is untouched and still owner-only for a private row.
 *
 * This used to read a view of the same name and shape. migration_v45 replaced
 * it: a GRANTed view is a table to PostgREST, so `?select=*` with no filter
 * handed back every account in the database. The function takes a search term,
 * refuses anything under two characters and caps its own result, so there is no
 * single request that returns the user list.
 *
 * BLOCKS ARE THE SECOND GATE, added in v48, and they are the reason this now
 * runs through the visitor's own session instead of the shared anon client.
 * Until then the function returned the same rows to everybody, so a session
 * would have changed nothing. A block is about one named person, so the
 * function has to know who is asking: it drops any account on the other side of
 * a block in EITHER direction — the person who blocked you and the person you
 * blocked both disappear from your results. Called without a session, auth.uid()
 * is NULL, nothing matches, and every block silently stops applying to search.
 *
 * Still never the service role. That would bypass the policies underneath
 * along with the point of asking.
 */

export interface UserResult {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  url: string
}

/** A row from search_profile_cards. username is non-null — the function filters. */
type ProfileRow = ProfileCard & { username: string }

/** Fetch ceiling per field, before ranking. Ranking needs the exact match in hand. */
const FETCH_LIMIT = 50

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
  // "@santo" should find santo. The function normalises the same way, so this
  // is for the ranking below, which compares against the cleaned term.
  const q = rawQuery.trim().replace(/^@+/, '').toLowerCase()
  if (q.length < 2) return []

  try {
    // One round trip instead of two. Matching both username and display_name
    // used to need a query each — a single PostgREST .or() string breaks on
    // user input containing a comma or a parenthesis — but inside the function
    // it is an ordinary OR, and the wildcard escaping happens there too.
    const supabase = await getSupabaseServer()
    const { data, error } = await supabase
      .rpc('search_profile_cards', { q, max_rows: FETCH_LIMIT })

    if (error) {
      console.error('[search] people query failed:', error.message)
      return []
    }

    return rank((data ?? []) as ProfileRow[], q)
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
