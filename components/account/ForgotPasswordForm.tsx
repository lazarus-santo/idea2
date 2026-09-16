'use client'

import { useState } from 'react'
import Link from 'next/link'
import { getSupabaseBrowser } from '@/lib/supabase-browser'

/**
 * Request a password reset link.
 *
 * The success message is deliberately the same whether or not the address has
 * an account: "if this address has an account". Saying "no account found"
 * would turn this form into a way to check which email addresses are
 * registered here.
 */
export default function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)

    const supabase = getSupabaseBrowser()
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      // /auth/callback handles every shape Supabase sends back and then sends
      // the person to /reset-password to choose the new one.
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/reset-password')}`,
    })

    if (error) {
      setError(error.message)
      setBusy(false)
      return
    }

    setBusy(false)
    setSent(true)
  }

  if (sent) {
    return (
      <>
        <p className="ac-notice">
          If <strong>{email.trim()}</strong> has an account, a reset link is on its way.
          The link works once, and expires after an hour.
        </p>
        <p className="ac-hint" style={{ marginBottom: 24 }}>
          Nothing arrived? Check your spam folder, then try again with another address.
        </p>
        <div className="ac-btn-row">
          <button
            type="button"
            className="ac-btn ac-btn--secondary ac-btn--inline"
            onClick={() => { setSent(false); setError(null) }}
          >
            Use a different address
          </button>
          <Link href="/login" className="ac-btn ac-btn--secondary ac-btn--inline">
            Back to sign in
          </Link>
        </div>
      </>
    )
  }

  return (
    <form onSubmit={submit}>
      <label className="ac-field">
        <span className="ac-label">Email</span>
        <input
          className="ac-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          autoFocus
        />
      </label>

      {error && <p className="ac-error">{error}</p>}

      <button className="ac-btn" type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send reset link'}
      </button>

      <p className="ac-hint" style={{ marginTop: 16 }}>
        <Link href="/login">Back to sign in</Link>
      </p>
    </form>
  )
}
