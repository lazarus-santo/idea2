'use client'

import { useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'

export default function ResetPasswordForm() {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('At least 8 characters.')
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
      <label className="ac-field">
        <span className="ac-label">New password</span>
        <input
          className="ac-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
          autoFocus
        />
      </label>

      {error && <p className="ac-error">{error}</p>}

      <button className="ac-btn" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save password'}
      </button>
    </form>
  )
}
