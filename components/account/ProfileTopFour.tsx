import Link from 'next/link'
import type { ProfileLogEntry } from '@/lib/exhibition-logs'
import type { ProfileReadingLogEntry } from '@/lib/reading-log-types'
import {
  padToFour,
  contentKey,
  type TopFourExhibition,
  type TopFourContentItem,
  type TopFourCandidate,
} from '@/lib/top-four-types'
import TopFourEditor from '@/components/account/TopFourEditor'
import '@/app/top-four.css'

/**
 * Somebody's two Top Fours, at the top of their profile.
 *
 * Presentational and server-rendered, like ProfileLog and ProfileReadingLog:
 * every privacy decision was already made in the database by
 * profile_top_four_exhibitions() and profile_top_four_content(), which ask
 * can_view_profile() — the same gate as the logs, the follower lists and the
 * feed. Nothing here re-checks any of that, and nothing here should start to.
 *
 * ── WHERE THE EDITOR'S CANDIDATES COME FROM, AND WHY THEY COST NOTHING ──────
 *
 * The two log arrays this takes are the ones the profile page has ALREADY
 * fetched to render the logs below. On your own profile the viewer is the
 * owner, so they are the complete log, and filtering them to seen/read is the
 * eligible list — no second query, and no second idea of what "eligible"
 * means. The database enforces the rule independently either way
 * (migration_v64); this is only about what gets offered.
 *
 * They are ignored entirely on somebody else's profile, where there is no
 * editor to feed.
 *
 * ── EMPTY SLOTS ARE DRAWN, EMPTY LISTS ARE NOT ──────────────────────────────
 *
 * A list with two picks shows two entries and two empty slots, because the
 * shape is the point — a Top Four with two in it is visibly unfinished, and
 * the brief asks for that.
 *
 * A list with NOTHING in it is different, and the two cases are split on whose
 * profile it is. On your own it renders as four empty slots with a Choose
 * button, because otherwise the feature is invisible to the only person who
 * can use it. On somebody else's it renders nothing at all: four dashed boxes
 * on a stranger's profile say "this person has not done a thing you cannot see
 * them do", which is noise rather than information.
 */

function Stars({ rating, liked }: { rating: number | null; liked: boolean }) {
  if (rating === null && !liked) return null
  return (
    <span className="tf-marks">
      {rating !== null && (
        <span className="tf-stars" aria-label={`Rated ${rating} out of 5`}>
          {'★'.repeat(rating)}
        </span>
      )}
      {liked && <span aria-label="Liked">♥</span>}
    </span>
  )
}

/**
 * One slot, filled or not.
 *
 * The rank is always drawn, on both — it is what makes the four read as an
 * ordered list rather than four things that happen to be next to each other.
 */
function Slot({
  rank,
  children,
}: {
  rank: number
  children: React.ReactNode | null
}) {
  return (
    <li className={children ? 'tf-slot' : 'tf-slot tf-slot--empty'}>
      <span className="tf-rank">{rank}</span>
      {children ?? <span className="tf-slot-placeholder" aria-label="Empty slot" />}
    </li>
  )
}

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return <span className="tf-thumb tf-thumb--none" aria-hidden="true" />
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="tf-thumb" src={src} alt={alt} />
}

function ExhibitionSlots({ entries }: { entries: TopFourExhibition[] }) {
  return (
    <ol className="tf-slots">
      {padToFour(entries).map((entry, i) => (
        <Slot key={entry?.exhibition_id ?? `empty-${i}`} rank={i + 1}>
          {entry && (
            <Link href={`/exhibitions/${entry.exhibition_id}`} className="tf-item">
              <Thumb src={entry.image_url} alt="" />
              <span className="tf-item-text">
                <span className="tf-item-title">{entry.show_title}</span>
                {entry.venue_name && (
                  <span className="tf-item-sub">{entry.venue_name}</span>
                )}
                <Stars rating={entry.rating} liked={entry.liked} />
              </span>
            </Link>
          )}
        </Slot>
      ))}
    </ol>
  )
}

function ContentSlots({ entries }: { entries: TopFourContentItem[] }) {
  return (
    <ol className="tf-slots">
      {padToFour(entries).map((entry, i) => (
        <Slot
          key={entry ? contentKey(entry.content_type, entry.content_id) : `empty-${i}`}
          rank={i + 1}
        >
          {entry && (
            /* Out to the article itself, as the reading log does: a preread
               has no page of its own here, and the thing that was picked is
               the piece. */
            <a
              className="tf-item"
              href={entry.article_url ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Thumb src={entry.thumbnail_url} alt="" />
              <span className="tf-item-text">
                <span className="tf-item-title">
                  {entry.title ?? entry.article_url ?? 'Untitled'}
                </span>
                {(entry.publication || entry.author) && (
                  <span className="tf-item-sub">
                    {[entry.publication, entry.author].filter(Boolean).join(' · ')}
                  </span>
                )}
                <Stars rating={entry.rating} liked={entry.liked} />
                {/* A frozen preread keeps its slot and its original content —
                    migration_v61's freeze, carried through v63's log into
                    v64's list. Saying so is honest; hiding either half is not. */}
                {entry.superseded && (
                  <span className="tf-item-frozen">
                    The version you read — the show&rsquo;s page has since been updated.
                  </span>
                )}
              </span>
            </a>
          )}
        </Slot>
      ))}
    </ol>
  )
}

/** A logged show, as something the editor can offer. */
function exhibitionCandidates(log: ProfileLogEntry[]): TopFourCandidate[] {
  return log
    .filter((e) => e.status === 'seen')
    .map((e) => ({
      key: e.exhibition_id,
      title: e.show_title,
      subtitle: e.venue_name,
    }))
}

/** A logged article, likewise. The key is the PAIR — an id alone is ambiguous. */
function contentCandidates(log: ProfileReadingLogEntry[]): TopFourCandidate[] {
  return log
    .filter((e) => e.status === 'read')
    .map((e) => ({
      key: contentKey(e.content_type, e.content_id),
      title: e.title ?? e.article_url ?? 'Untitled',
      subtitle: [e.publication, e.author].filter(Boolean).join(' · ') || null,
    }))
}

export default function ProfileTopFour({
  exhibitions,
  content,
  exhibitionLog,
  readingLog,
  isOwnProfile,
}: {
  exhibitions: TopFourExhibition[]
  content: TopFourContentItem[]
  /** Only read on your own profile, to seed the editor. See the note above. */
  exhibitionLog: ProfileLogEntry[]
  readingLog: ProfileReadingLogEntry[]
  isOwnProfile: boolean
}) {
  const showExhibitions = isOwnProfile || exhibitions.length > 0
  const showContent = isOwnProfile || content.length > 0

  if (!showExhibitions && !showContent) return null

  return (
    <div className="tf-block">
      {showExhibitions && (
        <section className="tf-section">
          <div className="tf-head">
            <h2 className="tf-title">Top four shows</h2>
            {isOwnProfile && (
              <TopFourEditor
                kind="exhibitions"
                candidates={exhibitionCandidates(exhibitionLog)}
                initial={exhibitions.map((e) => e.exhibition_id)}
              />
            )}
          </div>
          <ExhibitionSlots entries={exhibitions} />
          {isOwnProfile && exhibitions.length === 0 && (
            <p className="tf-hint">
              Pick four from the shows you have marked as seen.
            </p>
          )}
        </section>
      )}

      {showContent && (
        <section className="tf-section">
          <div className="tf-head">
            <h2 className="tf-title">Top four reads</h2>
            {isOwnProfile && (
              <TopFourEditor
                kind="content"
                candidates={contentCandidates(readingLog)}
                initial={content.map((e) => contentKey(e.content_type, e.content_id))}
              />
            )}
          </div>
          <ContentSlots entries={content} />
          {isOwnProfile && content.length === 0 && (
            <p className="tf-hint">
              Pick four from the articles you have marked as read.
            </p>
          )}
        </section>
      )}
    </div>
  )
}
