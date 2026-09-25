'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import LogoMark from '@/components/LogoMark'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import '@/app/account.css'

/**
 * Completes a sign-in whose tokens arrived in the URL fragment.
 *
 * WHY THIS PAGE EXISTS. Supabase returns the session as `#access_token=...`
 * whenever the browser opening the email link is not the browser that started
 * the flow — open the confirmation mail on your laptop after signing up on
 * your phone, and that is what you get. A fragment is never sent to the
 * server, so no route handler can read it; only code running in the browser
 * can. Without this page the person is confirmed but bounced to the login
 * page with an error, which is exactly the bug this fixes.
 *
 * Everything else (a PKCE `code`, or a `token_hash` from a custom template) is
 * handled server-side in /auth/callback; this page is only the fallback.
 */
export default function AuthFinishPage() {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // The work lives in its own function rather than the effect body so that
    // no state is set synchronously while the effect runs, and `cancelled`
    // keeps a late reply from touching an unmounted page.
    let cancelled = false

    async function complete() {
      const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))

      // Supabase reports its own failures in the fragment too.
      const fragmentError = params.get('error_description') ?? params.get('error')
      if (fragmentError) {
        if (!cancelled) setError(fragmentError.replace(/\+/g, ' '))
        return
      }

      const accessToken = params.get('access_token')
      const refreshToken = params.get('refresh_token')
      if (!accessToken || !refreshToken) {
        if (!cancelled) {
          setError('This link is missing its sign-in details. It may have already been used.')
        }
        return
      }

      const { error } = await getSupabaseBrowser().auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })
      if (cancelled) return

      if (error) {
        setError(error.message)
        return
      }

      const rawNext = new URLSearchParams(window.location.search).get('next') ?? '/'
      const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/'
      // A full load, not a router push: the session cookie was just written
      // and every server component has to render with it.
      window.location.replace(next)
    }

    complete()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="ac-page">
      <div className="ac-shell">
        <Link href="/" className="ac-back"><LogoMark /></Link>
        {error ? (
          <>
            <h1 className="ac-title">That link didn&rsquo;t work</h1>
            <p className="ac-subtitle">{error}</p>
            <Link href="/login" className="ac-btn">Back to sign in</Link>
          </>
        ) : (
          <>
            <h1 className="ac-title">Signing you in…</h1>
            <p className="ac-subtitle">One moment.</p>
          </>
        )}
      </div>
    </div>
  )
}
