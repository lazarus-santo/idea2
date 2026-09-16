'use client'

import { useRef, useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'

/**
 * Pick a profile picture.
 *
 * The file goes to the `avatars` bucket under a folder named with the
 * person's uuid — that path is what the storage policies in migration_v40
 * match on, so nobody can write into anyone else's folder. The bucket also
 * enforces the 2MB cap and the image types; the checks here just fail faster
 * and in plainer words.
 *
 * The upload happens immediately, but avatar_url is only handed to the parent
 * form — it lands on the profile when the form is saved.
 */
const MAX_BYTES = 2 * 1024 * 1024
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp']

export default function AvatarField({
  userId,
  avatarUrl,
  onChange,
  initials,
}: {
  userId: string
  avatarUrl: string | null
  onChange: (url: string | null) => void
  initials?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File) {
    setError(null)

    if (!ACCEPTED.includes(file.type)) {
      setError('Use a JPEG, PNG or WebP image.')
      return
    }
    if (file.size > MAX_BYTES) {
      setError('That image is over 2MB. Try a smaller one.')
      return
    }

    setBusy(true)
    const supabase = getSupabaseBrowser()
    const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    // Timestamped name so a replaced picture is not served from cache under
    // the old URL.
    const path = `${userId}/avatar-${Date.now()}.${extension}`

    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(path, file, { upsert: true, contentType: file.type })

    if (uploadError) {
      setError(uploadError.message)
      setBusy(false)
      return
    }

    const { data } = supabase.storage.from('avatars').getPublicUrl(path)
    onChange(data.publicUrl)

    // Best effort tidy-up: remove this person's earlier avatars so the bucket
    // does not accumulate every version. Their own folder, their own policy.
    const { data: existing } = await supabase.storage.from('avatars').list(userId)
    const stale = (existing ?? [])
      .map((f) => `${userId}/${f.name}`)
      .filter((p) => p !== path)
    if (stale.length) await supabase.storage.from('avatars').remove(stale)

    setBusy(false)
  }

  return (
    <div className="ac-avatar-row">
      {/* A plain img, not next/image: these are small, already-sized files on
          a domain that would otherwise need adding to next.config. */}
      {avatarUrl
        // eslint-disable-next-line @next/next/no-img-element
        ? <img className="ac-avatar" src={avatarUrl} alt="" />
        : <div className="ac-avatar ac-avatar--placeholder">{initials ?? '?'}</div>}

      <div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(',')}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) upload(file)
            e.target.value = ''
          }}
        />
        <div className="ac-btn-row">
          <button
            type="button"
            className="ac-btn ac-btn--secondary ac-btn--inline"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {busy ? 'Uploading…' : avatarUrl ? 'Replace photo' : 'Add photo'}
          </button>
          {avatarUrl && !busy && (
            <button
              type="button"
              className="ac-btn ac-btn--secondary ac-btn--inline"
              onClick={() => onChange(null)}
            >
              Remove
            </button>
          )}
        </div>
        {error ? <p className="ac-error">{error}</p> : <p className="ac-hint">JPEG, PNG or WebP. Up to 2MB.</p>}
      </div>
    </div>
  )
}
