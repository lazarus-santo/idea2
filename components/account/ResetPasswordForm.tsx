'use client'

import { useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import PasswordField from '@/components/account/PasswordField'

export default function ResetPasswordForm() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Shown under the second field as soon as there is something to compare, so
  // the mismatch is visible before anyone reaches for the button.
  const mismatch = confirmPassword.length > 0 && password !== confirmPassword

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('At least 8 characters.')
      return
    }

    // Checked here as well as in the disabled button: a form can still be
    // submitted with Enter, and the two passwords differing must never reach
    // updateUser — it would silently save whichever one the first field held.
    if (password !== confirmPassword) {
      setError("Passwords don't match.")
      return
    }

    setBusy(true)
    const supabase = getSupabaseBrowser()
    const { error } = await supabase.auth.updateUser({ password })

    if (error) {
      // The usual cause is an expired or already-used link: the session the
      // reset created is gone, so there is nobody to update.
      setError(`${error.message} You may need a fresh reset link.`)
      setBusy(false)
      return
    }

    window.location.href = '/settings'
  }

  return (
    <form onSubmit={submit}>
      <PasswordField
        id="new-password"
        label="New password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        minLength={8}
        required
        autoFocus
        hint="At least 8 characters."
      />

      <PasswordField
        id="confirm-new-password"
        label="Confirm new password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        autoComplete="new-password"
        minLength={8}
        required
        error={mismatch ? "Passwords don't match." : null}
      />

      {error && <p className="ac-error">{error}</p>}

      <button
        className="ac-btn"
        type="submit"
        disabled={busy || mismatch || password.length === 0 || confirmPassword.length === 0}
        style={{ marginTop: 8 }}
      >
        {busy ? 'Saving…' : 'Save password'}
      </button>
    </form>
  )
}
