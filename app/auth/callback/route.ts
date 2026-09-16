import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { getSupabaseServer } from '@/lib/supabase-server'

/**
 * Where Google and Apple send people back to.
 *
 * The provider returns a one-time `code`; exchanging it here is what turns it
 * into a session cookie. This has to be a Route Handler, not a page — pages
 * cannot write cookies.
 *
 * The destination afterwards is decided by whether the person has a username
 * yet, not by the provider: a first-time Apple or Google signup lands on
 * /onboarding, a returning person lands where they were headed.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next') ?? '/'

  // The provider itself refused (cancelled at the Apple/Google screen, or a
  // misconfigured client). Say so on the login page rather than 500ing.
  const providerError = searchParams.get('error_description') ?? searchParams.get('error')
  if (providerError) {
    return NextResponse.redirect(
      `${baseUrl(request, origin)}/login?error=${encodeURIComponent(providerError)}`
    )
  }

  const supabase = await getSupabaseServer()

  // Supabase hands the session back in one of three shapes, and which one you
  // get is not a choice the app makes:
  //   ?code=...        PKCE — a signup or reset started in THIS browser.
  //   ?token_hash=...  what a custom email template emits.
  //   #access_token=.. no PKCE verifier in this browser (the email was opened
  //                    on a different device), so Supabase falls back to the
  //                    implicit flow and puts the tokens in the URL fragment.
  // A fragment is never sent to the server, so that last one cannot be read
  // here at all — it is handed to /auth/finish, which reads it in the browser.
  // Structural type rather than AuthError: the three calls below return
  // different error classes, and all this code needs from any of them is the
  // message it puts in the redirect.
  let error: { message: string } | null = null
  if (code) {
    ({ error } = await supabase.auth.exchangeCodeForSession(code))
  } else if (tokenHash && type) {
    ({ error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash }))
  } else {
    return NextResponse.redirect(
      `${baseUrl(request, origin)}/auth/finish?next=${encodeURIComponent(safeNext(next))}`
    )
  }

  if (error) {
    return NextResponse.redirect(
      `${baseUrl(request, origin)}/login?error=${encodeURIComponent(error.message)}`
    )
  }

  return NextResponse.redirect(`${baseUrl(request, origin)}${await destination(next)}`)
}

/**
 * Has this person finished onboarding?
 *
 * The profile row always exists — migration_v40's trigger writes it in the
 * same transaction as the signup — so a missing username is the only signal
 * needed, and there is no "profile not created yet" case to wait out.
 */
async function destination(next: string): Promise<string> {
  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return '/login?error=no_session'

  const { data: profile } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile?.username) {
    return `/onboarding?next=${encodeURIComponent(safeNext(next))}`
  }
  return safeNext(next)
}

/**
 * Only ever redirect within this site. `next` arrives in a URL anyone can
 * craft, so an absolute one would make this an open redirect — a link that
 * looks like idea2.xyz and lands on somebody else's sign-in page.
 */
function safeNext(next: string): string {
  if (!next.startsWith('/') || next.startsWith('//')) return '/'
  return next
}

/**
 * Behind Vercel's proxy the request's own origin is the internal host, so a
 * redirect built from it would send people to a URL that is not the site.
 * x-forwarded-host is what the browser actually asked for.
 */
function baseUrl(request: NextRequest, origin: string): string {
  const forwardedHost = request.headers.get('x-forwarded-host')
  if (process.env.NODE_ENV === 'production' && forwardedHost) {
    return `https://${forwardedHost}`
  }
  return origin
}
