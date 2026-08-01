'use client'

/**
 * Client-side companion to lib/api-auth.ts.
 *
 * Every /api/admin/* route now requires the `x-admin-secret` header. Rather than
 * thread the password through seven tab components and ~40 call sites as a prop,
 * the admin page records it once and the tabs call `adminFetch` in place of
 * `fetch`. The call signature is identical, so the diff at each site is one word.
 *
 * The secret is not a new exposure: it already arrives as the `?pw=` query
 * parameter and is already serialized into the RSC payload as DashboardTab's
 * `adminPw` prop. This module is a transport convenience, not a secret store —
 * anyone who can read it can read the URL bar.
 */

let adminSecret = ''

/** Called by the admin page shells during render, before any tab effect runs. */
export function setAdminSecret(pw: string) {
  adminSecret = pw
}

/**
 * `fetch` with the admin credential attached.
 *
 * The header goes on unconditionally rather than only for /api/admin/* paths:
 * EditorPicksTab passes its endpoint in as a `fetchUrl` prop that is sometimes
 * the public /api/readings, and a rule that depends on the URL shape is exactly
 * the kind of thing that quietly stops matching. Sending the header to a public
 * same-origin route costs nothing.
 */
export function adminFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-admin-secret': adminSecret },
  })
}
