import Link from 'next/link'
import type { ProfileReadingLogEntry } from '@/lib/reading-log-types'
import '@/app/exhibition-log.css'
import '@/app/reading-log.css'

/**
 * Somebody's reading log, on their profile — the articles, under the shows.
 *
 * Presentational and server-rendered, exactly like ProfileLog: every privacy
 * decision was already made in the database by public.profile_reading_logs(),
 * which applies the profile gate (can_view_profile — public, or an approved
 * follower, and never across a block) and then the note gate on top of it.
 * Nothing here re-checks any of that, and nothing here should start to. A
 * private note arrives as a null comment and this component simply has nothing
 * to render.
 *
 * The page does not render this at all on a locked profile, so an empty list
 * never means "hidden" — it means nothing has been logged.
 *
 * ── A FROZEN PREREAD STILL BELONGS HERE ─────────────────────────────────────
 *
 * When a logged preread is repaired, migration_v61 freezes it: the row is
 * blanked and vanishes from the exhibition page, while a new row takes over
 * there. The entry below keeps rendering with the FROZEN row's title and
 * publication, because that is the piece the person read — the function does
 * not filter those rows out, which is the whole point of the freeze.
 *
 * `superseded` is why the "version you read" line exists. Without it the entry
 * would quietly disagree with the exhibition page, and the honest thing is to
 * say the piece has since been replaced rather than to hide either half.
 */
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function Entry({
  entry,
  isOwnProfile,
}: {
  entry: ProfileReadingLogEntry
  isOwnProfile: boolean
}) {
  const heading = entry.title ?? entry.article_url ?? 'Untitled'

  return (
    <div className="el-entry">
      {/* Out to the article itself. A preread has no page of its own here, and
          a reading's /readings/[id] page is a stub around the same link — the
          thing the person logged is the piece, so that is where this goes. */}
      {entry.article_url ? (
        <a
          className="el-entry-title"
          href={entry.article_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {heading}
        </a>
      ) : (
        <p className="el-entry-title">{heading}</p>
      )}

      <p className="el-entry-meta">
        {[entry.publication, entry.author].filter(Boolean).join(' · ')}
        {entry.exhibition_id && entry.show_title && (
          <>
            {(entry.publication || entry.author) && ' · '}
            <Link href={`/exhibitions/${entry.exhibition_id}`} className="rl-entry-link">
              {entry.show_title}
            </Link>
          </>
        )}
      </p>

      <div className="el-entry-marks">
        <span>
          {entry.status === 'read'
            ? `Read ${formatWhen(entry.logged_at)}`
            : 'On the reading list'}
        </span>
        {/* Rating and like only ever exist at 'read' — the database refuses
            them otherwise — so there is no case to guard for here. */}
        {entry.rating !== null && (
          <span className="el-entry-stars" aria-label={`Rated ${entry.rating} out of 5`}>
            {'★'.repeat(entry.rating)}
          </span>
        )}
        {entry.liked && <span aria-label="Liked">♥</span>}
      </div>

      {entry.superseded && (
        <p className="rl-entry-frozen">
          This is the version you read — the show&rsquo;s page has since been updated.
        </p>
      )}

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

export default function ProfileReadingLog({
  entries,
  isOwnProfile,
  displayName,
}: {
  entries: ProfileReadingLogEntry[]
  isOwnProfile: boolean
  displayName: string
}) {
  return (
    <section className="el-list">
      <div className="el-list-head">
        <h2 className="el-list-title">Reading log</h2>
        {entries.length > 0 && <span className="el-list-count">{entries.length}</span>}
      </div>

      {entries.length === 0 ? (
        <p className="el-list-empty">
          {isOwnProfile
            ? 'Nothing logged yet. Save an article to your reading list from Readings, or from a show’s preread.'
            : `${displayName} has not logged any reading yet.`}
        </p>
      ) : (
        entries.map((entry) => (
          // content_type is part of the key for the same reason it is part of
          // the primary key: the two id spaces are independent, so an id alone
          // is not unique across the list.
          <Entry
            key={`${entry.content_type}:${entry.content_id}`}
            entry={entry}
            isOwnProfile={isOwnProfile}
          />
        ))
      )}
    </section>
  )
}
