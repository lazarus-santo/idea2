import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

/**
 * Session refresh, and nothing more trusted than that.
 *
 * Next 16 renamed the `middleware` file convention to `proxy` (it runs on the
 * Node runtime and the `runtime` config option is rejected here). This file
 * exists because Supabase access tokens expire: without something that
 * refreshes them ahead of a render, a signed-in person gets logged out at
 * roughly hourly random, and Server Components cannot write the new cookies
 * themselves.
 *
 * WHAT THIS DOES NOT DO: decide who may see what. The redirects below are
 * optimistic — they only look at whether a session cookie parses, because this
 * runs on every request including prefetches, and a database check here would
 * cost a round trip per prefetch. Someone who forges a cookie gets past this
 * file and is then refused by the real checks: lib/auth.ts on the server and
 * the RLS policies in migration_v40 at the database. Never treat arriving at a
 * page as proof of anything.
 */

/** Signed-out visitors are bounced from these, with a route back afterwards. */
const REQUIRES_SESSION = ['/settings', '/onboarding', '/crawls']

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value)
          })
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
          // Cache-Control/Expires/Pragma from the library. A response that sets
          // auth cookies must never be cached: a CDN that stored it would hand
          // one person's session to the next visitor.
          Object.entries(headers).forEach(([key, value]) => {
            response.headers.set(key, value)
          })
        },
      },
    }
  )

  // Triggers the refresh. Must be awaited before returning the response, or
  // the rotated tokens never reach setAll and so never reach the browser.
  const { data } = await supabase.auth.getClaims()
  const signedIn = Boolean(data?.claims)

  const { pathname } = request.nextUrl

  if (!signedIn && REQUIRES_SESSION.some((p) => pathname.startsWith(p))) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (signedIn && pathname === '/login') {
    return NextResponse.redirect(new URL('/settings', request.url))
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. /api is included so
     * that route handlers see refreshed tokens too.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)',
  ],
}
