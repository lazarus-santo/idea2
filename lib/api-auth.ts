/**
 * Shared auth gate for every route that triggers agent work.
 *
 * These routes all spend real money on each invocation — Browserbase sessions,
 * Anthropic completions, Exa searches — and write to live Supabase, so an
 * unauthenticated one is a billable endpoint anyone can hold open once the app
 * is on a public domain. This lives in one place because the check was
 * previously copy-pasted per route and drifted: /api/scrape and
 * /api/admin/audit-prereads had no check at all while /api/curate did.
 *
 * Two accepted credentials, matching how the routes are actually called:
 *   - `Authorization: Bearer <CRON_SECRET>` — what Vercel Cron sends.
 *   - `x-admin-secret: <ADMIN_PASSWORD>`   — what the admin dashboard's
 *     "Run Now" buttons send (threaded down as the `adminPw` prop).
 *
 * Fails closed: if the corresponding environment variable is unset, that
 * credential is not accepted at all, rather than comparing undefined to
 * undefined and letting a blank secret through.
 */
export function isAuthorizedAgentRequest(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`) {
    return true
  }

  const adminPassword = process.env.ADMIN_PASSWORD
  if (adminPassword && request.headers.get('x-admin-secret') === adminPassword) {
    return true
  }

  return false
}

/** Standard 401 body, so every gated route rejects identically. */
export function unauthorized(): Response {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}
