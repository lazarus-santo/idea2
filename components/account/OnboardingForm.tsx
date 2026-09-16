'use client'

import { useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import {
  BIO_MAX,
  DISPLAY_NAME_MAX,
  normalizeUsername,
  profilePath,
  validateBio,
  validateDisplayName,
  validateUsername,
} from '@/lib/profile'
import AvatarField from '@/components/account/AvatarField'

/**
 * Claim a username and fill in the profile.
 *
 * The write goes straight to Postgres as the signed-in person; the update
 * policy in migration_v40 is what allows their own row and nothing else. The
 * row already exists — the signup trigger created it — so this updates, never
 * inserts.
 */
export default function OnboardingForm({
  userId,
  suggestedName,
  suggestedUsername,
  next,
}: {
  userId: string
  suggestedName: string
  suggestedUsername: string
  next: string | null
}) {
  const [username, setUsername] = useState(suggestedUsername)
  const [displayName, setDisplayName] = useState(suggestedName)
  const [bio, setBio] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Shown as you type; the database enforces the same rules on write.
  const usernameProblem = username ? validateUsername(username) : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const cleanUsername = normalizeUsername(username)
    const problem =
      validateUsername(cleanUsername) ??
      validateDisplayName(displayName) ??
      validateBio(bio)
    if (problem) {
      setError(problem)
      return
    }

    setBusy(true)
    const supabase = getSupabaseBrowser()
    const { error } = await supabase
      .from('profiles')
      .update({
        username: cleanUsername,
        display_name: displayName.trim(),
        bio: bio.trim() || null,
        avatar_url: avatarUrl,
      })
      .eq('id', userId)

    if (error) {
      setError(friendlyError(error.code, error.message))
      setBusy(false)
      return
    }

    // Full load so every server component re-renders with the new profile.
    window.location.href = next && next.startsWith('/') ? next : profilePath(cleanUsername)
  }

  return (
    <form onSubmit={submit}>
      <AvatarField userId={userId} avatarUrl={avatarUrl} onChange={setAvatarUrl} />

      <label className="ac-field">
        <span className="ac-label">Username</span>
        <div className="ac-input-prefix">
          <span>@</span>
          <input
            className="ac-input"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={30}
            required
            autoFocus
          />
        </div>
        {usernameProblem
          ? <p className="ac-error">{usernameProblem}</p>
          : <p className="ac-hint">Letters, numbers and underscores. 3–30 characters.</p>}
      </label>

      <label className="ac-field">
        <span className="ac-label">Display name</span>
        <input
          className="ac-input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={DISPLAY_NAME_MAX}
          placeholder="Your name"
          required
        />
        <p className="ac-hint">The name shown on your profile.</p>
      </label>

      <label className="ac-field">
        <span className="ac-label">Bio</span>
        <textarea
          className="ac-textarea"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={BIO_MAX}
          placeholder="Optional."
        />
        <p className="ac-count">{bio.length}/{BIO_MAX}</p>
      </label>

      {error && <p className="ac-error">{error}</p>}

      <button className="ac-btn" type="submit" disabled={busy || Boolean(usernameProblem)}>
        {busy ? 'Saving…' : 'Finish'}
      </button>
      <p className="ac-hint" style={{ marginTop: 14 }}>
        Your profile is public by default. You can make it private in settings.
      </p>
    </form>
  )
}

/**
 * Postgres speaks in constraint names; people do not.
 *
 * 23505 is the UNIQUE violation on username, and username_reserved is the
 * message raised by the reserved-name trigger.
 */
export function friendlyError(code: string | undefined, message: string): string {
  if (code === '23505') return 'That username is taken.'
  if (message.includes('username_reserved')) return 'That username is reserved.'
  if (message.includes('profiles_username_format')) {
    return 'Usernames use letters, numbers and underscores, and cannot start or end with an underscore.'
  }
  if (message.includes('profiles_bio_length')) return `Bios are at most ${BIO_MAX} characters.`
  if (message.includes('profiles_display_name_length')) {
    return `Display names are at most ${DISPLAY_NAME_MAX} characters.`
  }
  return message
}
