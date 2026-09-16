'use client'

import { useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'

/**
 * Sign in and create account: Apple, Google, and email + password.
 *
 * All three are Supabase Auth. The OAuth buttons hand off to the provider and
 * come back to /auth/callback; the email form either signs in directly or
 * sends a confirmation mail that lands on /auth/confirm.
 */

type Mode = 'signin' | 'signup'

/**
 * Apple sign-in is built and wired, but Apple is not configured in Supabase
 * yet — deliberately deferred until there is an app build in play. Until then
 * the button would take someone to a provider that refuses the request, so it
 * is not rendered at all. The code path below is untouched: flip this to true
 * once Apple is configured in the dashboard, and nothing else needs to change.
 */
const SHOW_APPLE_SIGN_IN = false

export default function LoginForm({
  next,
  initialError,
}: {
  next: string | null
  initialError: string | null
}) {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<null | 'apple' | 'google' | 'email' | 'reset'>(null)
  const [error, setError] = useState<string | null>(initialError)
  const [notice, setNotice] = useState<string | null>(null)

  /** Everything comes back through /auth/callback, which decides where next. */
  function callbackUrl(): string {
    const target = next && next.startsWith('/') ? next : '/'
    return `${window.location.origin}/auth/callback?next=${encodeURIComponent(target)}`
  }

  async function signInWithProvider(provider: 'apple' | 'google') {
    setBusy(provider)
    setError(null)
    const supabase = getSupabaseBrowser()
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: callbackUrl() },
    })
    if (error) {
      setError(error.message)
      setBusy(null)
    }
    // On success the browser leaves for the provider; no state to reset.
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault()
    setBusy('email')
    setError(null)
    setNotice(null)

    const supabase = getSupabaseBrowser()

    if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          // /auth/callback, not /auth/confirm: the link Supabase puts in the
          // signup email comes back carrying a PKCE `code`, which is what the
          // callback route exchanges for a session. /auth/confirm only ever
          // understood the `token_hash` shape that custom email templates
          // produce, so a real signup confirmed the account and then dropped
          // the person on the login page with an error.
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/onboarding')}`,
        },
      })

      if (error) {
        setError(error.message)
        setBusy(null)
        return
      }

      // With email confirmation on, there is no session yet — Supabase returns
      // a user with no session and the person has to click the link first.
      if (data.session) {
        window.location.href = '/onboarding'
        return
      }

      setNotice(`Check ${email} for a link to confirm your address.`)
      setBusy(null)
      return
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setBusy(null)
      return
    }

    // A full load, not a router push: the session cookie was just written and
    // every server component needs to render with it.
    window.location.href = next && next.startsWith('/') ? next : '/onboarding'
  }

  async function sendReset() {
    if (!email) {
      setError('Enter your email address first.')
      return
    }
    setBusy('reset')
    setError(null)
    const supabase = getSupabaseBrowser()
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/reset-password')}`,
    })
    if (error) setError(error.message)
    else setNotice(`If ${email} has an account, a reset link is on its way.`)
    setBusy(null)
  }

  return (
    <>
      {notice && <p className="ac-notice">{notice}</p>}

      <div className="ac-providers">
        {SHOW_APPLE_SIGN_IN && (
          <button
            type="button"
            className="ac-provider"
            onClick={() => signInWithProvider('apple')}
            disabled={busy !== null}
          >
            <AppleMark />
            {busy === 'apple' ? 'Opening Apple…' : 'Continue with Apple'}
          </button>
        )}
        <button
          type="button"
          className="ac-provider"
          onClick={() => signInWithProvider('google')}
          disabled={busy !== null}
        >
          <GoogleMark />
          {busy === 'google' ? 'Opening Google…' : 'Continue with Google'}
        </button>
      </div>

      <div className="ac-divider">or</div>

      <div className="ac-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signin'}
          className="ac-tab"
          onClick={() => { setMode('signin'); setError(null); setNotice(null) }}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signup'}
          className="ac-tab"
          onClick={() => { setMode('signup'); setError(null); setNotice(null) }}
        >
          Create account
        </button>
      </div>

      <form onSubmit={submitEmail}>
        <label className="ac-field">
          <span className="ac-label">Email</span>
          <input
            className="ac-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>

        <label className="ac-field">
          <span className="ac-label">Password</span>
          <input
            className="ac-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            minLength={8}
            required
          />
          {mode === 'signup' && <p className="ac-hint">At least 8 characters.</p>}
        </label>

        {error && <p className="ac-error">{error}</p>}

        <button className="ac-btn" type="submit" disabled={busy !== null}>
          {busy === 'email'
            ? 'Working…'
            : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      {mode === 'signin' && (
        <p className="ac-hint" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="ac-linkbtn"
            onClick={sendReset}
            disabled={busy !== null}
          >
            {busy === 'reset' ? 'Sending…' : 'Forgot your password?'}
          </button>
        </p>
      )}
    </>
  )
}

function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M16.365 1.43c0 1.14-.42 2.2-1.25 3.02-.9.9-1.97 1.42-3.13 1.33-.02-1.1.44-2.2 1.25-3 .84-.84 2.06-1.4 3.1-1.35.02.13.03.26.03.4zM20.9 17.1c-.36.83-.53 1.2-1 1.94-.65 1.02-1.57 2.3-2.7 2.31-1.01.01-1.27-.66-2.64-.65-1.37.01-1.65.66-2.66.65-1.14-.01-2-1.16-2.66-2.19-1.83-2.86-2.02-6.22-.89-8 .8-1.27 2.06-2.01 3.25-2.01 1.2 0 1.96.66 2.96.66.97 0 1.56-.66 2.95-.66 1.05 0 2.17.58 2.96 1.57-2.6 1.43-2.18 5.15.43 6.38z" />
    </svg>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.64h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.46z" />
      <path fill="#34A853" d="M12 23.5c3.11 0 5.72-1.03 7.62-2.79l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.540-2.03-6.45-4.75H1.7v2.98A11.5 11.5 0 0 0 12 23.5z" />
      <path fill="#FBBC05" d="M5.55 14.17a6.9 6.9 0 0 1 0-4.34V6.85H1.7a11.5 11.5 0 0 0 0 10.3l3.85-2.98z" />
      <path fill="#EA4335" d="M12 4.75c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.71 1.26 15.1.5 12 .5 7.7.5 3.99 2.97 1.7 6.85l3.85 2.98C6.46 7.11 9 4.75 12 4.75z" />
    </svg>
  )
}
