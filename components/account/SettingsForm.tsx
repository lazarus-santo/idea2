'use client'

import { useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import {
  BIO_MAX,
  DISPLAY_NAME_MAX,
  PRIVACY_OPTIONS,
  normalizePrivacy,
  normalizeUsername,
  profilePath,
  validateBio,
  validateDisplayName,
  validateUsername,
  type Profile,
  type ProfilePrivacy,
} from '@/lib/profile'
import AvatarField from '@/components/account/AvatarField'
import { friendlyError } from '@/components/account/OnboardingForm'

/**
 * Edit your profile, change who can see it, sign out, or delete the account.
 *
 * Profile edits are written by the person themselves under RLS. Deleting is
 * the exception — removing a login needs the service role, so it goes through
 * /api/account/delete, which reads the identity from the session rather than
 * from anything this form sends.
 */
export default function SettingsForm({
  profile,
  email,
  children,
}: {
  profile: Profile
  email: string | null
  /**
   * Sections that belong to Settings but are not part of the profile form —
   * the blocked and muted lists.
   *
   * A slot rather than an import, because they are server-rendered and this is
   * a client component. It sits here, BETWEEN the profile form and Account,
   * on purpose: those lists are ordinary management, and putting them after
   * "Delete account" meant scrolling past the one irreversible button on the
   * page to reach them. The danger zone goes last.
   */
  children?: React.ReactNode
}) {
  const [username, setUsername] = useState(profile.username ?? '')
  const [displayName, setDisplayName] = useState(profile.display_name ?? '')
  const [bio, setBio] = useState(profile.bio ?? '')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile.avatar_url)
  // Normalised on the way in: a row still holding v40's 'followers_only'
  // would otherwise match no radio and render the whole group unchecked.
  const [privacy, setPrivacy] = useState<ProfilePrivacy>(normalizePrivacy(profile.privacy))

  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteText, setDeleteText] = useState('')
  const [deleting, setDeleting] = useState(false)

  const usernameProblem = username ? validateUsername(username) : null

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)

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
        privacy,
      })
      .eq('id', profile.id)

    if (error) {
      setError(friendlyError(error.code, error.message))
      setBusy(false)
      return
    }

    setBusy(false)
    setSaved(true)

    // The handle is in the URL of the profile page, so a changed username
    // means the old link is gone — reload so every link on the site updates.
    if (cleanUsername !== profile.username) {
      window.location.href = profilePath(cleanUsername)
    }
  }

  async function deleteAccount() {
    setDeleting(true)
    setError(null)
    const res = await fetch('/api/account/delete', { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Could not delete the account.')
      setDeleting(false)
      return
    }
    window.location.href = '/'
  }

  return (
    <>
      <form onSubmit={save}>
        <AvatarField
          userId={profile.id}
          avatarUrl={avatarUrl}
          onChange={setAvatarUrl}
          initials={(displayName || username || '?').charAt(0).toUpperCase()}
        />

        <label className="ac-field">
          <span className="ac-label">Username</span>
          <div className="ac-input-prefix">
            <span>@</span>
            <input
              className="ac-input"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              autoCapitalize="none"
              spellCheck={false}
              maxLength={30}
              required
            />
          </div>
          {usernameProblem
            ? <p className="ac-error">{usernameProblem}</p>
            : <p className="ac-hint">Changing this changes your profile link.</p>}
        </label>

        <label className="ac-field">
          <span className="ac-label">Display name</span>
          <input
            className="ac-input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={DISPLAY_NAME_MAX}
            required
          />
        </label>

        <label className="ac-field">
          <span className="ac-label">Bio</span>
          <textarea
            className="ac-textarea"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={BIO_MAX}
          />
          <p className="ac-count">{bio.length}/{BIO_MAX}</p>
        </label>

        <div className="ac-field">
          <span className="ac-label">Who can see your profile</span>
          <div className="ac-choices">
            {PRIVACY_OPTIONS.map((option) => (
              <label className="ac-choice" key={option.value}>
                <input
                  type="radio"
                  name="privacy"
                  value={option.value}
                  checked={privacy === option.value}
                  onChange={() => setPrivacy(option.value)}
                />
                <span>
                  <span className="ac-choice-label">{option.label}</span>
                  <span className="ac-choice-desc">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {error && <p className="ac-error">{error}</p>}
        {saved && <p className="ac-hint">Saved.</p>}

        <button className="ac-btn" type="submit" disabled={busy || Boolean(usernameProblem)}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      {children}

      <section className="ac-section">
        <h2 className="ac-section-title">Account</h2>
        <p className="ac-meta">
          {email ? <>Signed in as {email}.</> : <>Signed in.</>}
        </p>
        <form method="POST" action="/auth/signout" className="ac-btn-row">
          <button className="ac-btn ac-btn--secondary ac-btn--inline" type="submit">
            Sign out
          </button>
        </form>
      </section>

      <section className="ac-section">
        <h2 className="ac-section-title">Delete account</h2>
        {!confirmingDelete ? (
          <>
            <p className="ac-meta">
              Removes your profile, your username and your photo. This cannot be undone.
            </p>
            <div className="ac-btn-row">
              <button
                type="button"
                className="ac-btn ac-btn--secondary ac-btn--inline"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete account
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="ac-meta">
              Type <strong>DELETE</strong> to confirm. Your username becomes available
              to someone else.
            </p>
            <input
              className="ac-input"
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              placeholder="DELETE"
              style={{ marginTop: 12 }}
            />
            <div className="ac-btn-row">
              <button
                type="button"
                className="ac-btn ac-btn--danger ac-btn--inline"
                disabled={deleteText !== 'DELETE' || deleting}
                onClick={deleteAccount}
              >
                {deleting ? 'Deleting…' : 'Delete for good'}
              </button>
              <button
                type="button"
                className="ac-btn ac-btn--secondary ac-btn--inline"
                onClick={() => { setConfirmingDelete(false); setDeleteText('') }}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </section>
    </>
  )
}
