import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { getSupabaseServer } from '@/lib/supabase-server'

/**
 * Where links inside our emails land: confirm-your-address after an
 * email/password signup, and the password reset link.
 *
 * Supabase sends a `token_hash` plus a `type`; verifying it here is what
 * creates the session. A reset link therefore arrives signed in, which is why
 * /reset-password can simply ask for the new password.
 *
 * WORTH KNOWING (operational, not code): these emails only arrive if the
 * project has a real mail sender configured. Supabase's built-in one is for
 * testing. And for anyone who signed up with Apple while hiding their address,
 * our sending domain must be registered with Apple, or mail to their
 * @privaterelay.appleid.com address is dropped silently — no bounce, no error.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next') ?? '/'

  if (!tokenHash || !type) {
    return NextResponse.redirect(`${origin}/login?error=invalid_link`)
  }

  const supabase = await getSupabaseServer()
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })

  if (error) {
    // Expired or already-used links land here — both are ordinary, and the
    // login page offers sending a fresh one.
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`
    )
  }

  const target = next.startsWith('/') && !next.startsWith('//') ? next : '/'
  return NextResponse.redirect(`${origin}${target}`)
}
