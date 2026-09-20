import Link from 'next/link'
import type { ProfileLogEntry } from '@/lib/exhibition-logs'
import '@/app/exhibition-log.css'

/**
 * Somebody's exhibition log, on their profile.
 *
 * Presentational and server-rendered: every privacy decision was already made
 * in the database by public.profile_exhibition_logs(), which applies the
 * profile gate (can_view_profile — public, or an approved follower, and never
 * across a block) and then the note gate on top of it. Nothing here re-checks
 * any of that, and nothing here should start to. A private note arrives as a
 * null comment and this component simply has nothing to render.
 *
 * The page does not render this at all on a locked profile, so there is no
 * case where an empty list means "hidden" — it means the person has not logged
 * anything.
 */
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatRun(start: string | null, end: string | null): string | null {
  if (!start && !end) return null
  const fmt = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  if (start && end) return `${fmt(start)} – ${fmt(end)}`
  return fmt((start ?? end)!)
}

function Entry({ entry, isOwnProfile }: { entry: ProfileLogEntry; isOwnProfile: boolean }) {
  const run = formatRun(entry.start_date, entry.end_date)

  return (
    <div className="el-entry">
      <Link href={`/exhibitions/${entry.exhibition_id}`} className="el-entry-title">
        {entry.show_title}
      </Link>
      <p className="el-entry-meta">
        {[entry.venue_name, run].filter(Boolean).join(' · ')}
      </p>

      <div className="el-entry-marks">
        <span>{entry.status === 'seen' ? `Seen ${formatWhen(entry.logged_at)}` : 'Want to see'}</span>
        {/* Rating and like only ever exist at 'seen' — the database refuses
            them otherwise — so there is no case to guard for here. */}
        {entry.rating !== null && (
          <span className="el-entry-stars" aria-label={`Rated ${entry.rating} out of 5`}>
            {'★'.repeat(entry.rating)}
          </span>
        )}
        {entry.liked && <span aria-label="Liked">♥</span>}
      </div>

      {entry.comment && (
        <>
          <p className="el-entry-note">{entry.comment}</p>
          {/* Only ever true on your own profile: a note you may not read comes
              back with a null visibility as well as a null comment, so this
              can never appear on somebody else's page. */}
          {isOwnProfile && entry.comment_visibility === 'private' && (
            <p className="el-entry-private">Only you can see this note</p>
          )}
        </>
      )}
    </div>
  )
}

export default function ProfileLog({
  entries,
  isOwnProfile,
  displayName,
}: {
  entries: ProfileLogEntry[]
  isOwnProfile: boolean
  displayName: string
}) {
  return (
    <section className="el-list">
      <div className="el-list-head">
        <h2 className="el-list-title">Exhibition log</h2>
        {entries.length > 0 && (
          <span className="el-list-count">{entries.length}</span>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="el-list-empty">
          {isOwnProfile
            ? 'Nothing logged yet. Mark a show Want to see or Seen from its page.'
            : `${displayName} has not logged any shows yet.`}
        </p>
      ) : (
        entries.map((entry) => (
          <Entry key={entry.exhibition_id} entry={entry} isOwnProfile={isOwnProfile} />
        ))
      )}
    </section>
  )
}
