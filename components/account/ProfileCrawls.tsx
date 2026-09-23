import Link from 'next/link'
import type { Crawl, SavedCrawl } from '@/lib/crawl-types'
import '@/app/crawls.css'

/**
 * Somebody's crawls, on their profile.
 *
 * ── WHO SEES WHAT (Phase 2, migration_v67) ─────────────────────────────────
 *
 * On your OWN profile: every crawl you have, draft, planned and completed.
 * On somebody else's: their COMPLETED crawls only, and only if you may see the
 * profile at all — the page renders this inside its unlocked branch, and the
 * list itself comes from a read under your session that returns nothing else.
 * The `isOwnProfile` prop picks the wording and the "Plan one" link; it does
 * not decide what is in `crawls`. RLS did that before this component ran.
 *
 * ── EVERY ROW OPENS THE MAP ────────────────────────────────────────────────
 *
 * A crawl is built on /map, so a saved one opens there too — ?crawl=<id>. Your
 * own opens editable (or fixed, once completed); somebody else's opens in the
 * map's read-only mode, drawn by the same code as the builder, so the two
 * cannot drift.
 */
export default function ProfileCrawls({
  crawls,
  isOwnProfile,
  displayName,
}: {
  crawls: Crawl[]
  isOwnProfile: boolean
  displayName: string
}) {
  // Nothing to say about a visitor's view of somebody with no completed
  // crawls: an empty "Crawls" heading on another person's profile is noise.
  if (!isOwnProfile && crawls.length === 0) return null

  return (
    <section className="pc-block">
      <div className="pc-head">
        <h2 className="pc-title">Crawls</h2>
        {isOwnProfile && <Link href="/map" className="pc-new">Plan one</Link>}
      </div>

      {crawls.length === 0 ? (
        <p className="pc-empty">
          No crawls yet. Pick stops on the{' '}
          <Link href="/map">map</Link> and save the walk between them.
        </p>
      ) : (
        <ul className="pc-list">
          {crawls.map((crawl) => (
            <li key={crawl.id} className="pc-row">
              <Link href={`/map?crawl=${crawl.id}`} className="pc-row-link">
                <span className="pc-row-title">{crawl.title}</span>
                <span className="pc-row-meta">
                  {crawl.status === 'completed' && crawl.like_count ? (
                    <span>♥ {crawl.like_count}</span>
                  ) : null}
                  {/* A visitor only ever sees completed crawls, so the badge
                      would say the same thing on every row. */}
                  {isOwnProfile && (
                    <span className={`pc-badge pc-badge--${crawl.status}`}>
                      {STATUS_LABEL[crawl.status]}
                    </span>
                  )}
                  <span>
                    {crawl.stop_count} stop{crawl.stop_count === 1 ? '' : 's'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {isOwnProfile ? (
        <p className="pc-privacy">
          Drafts and planned crawls are yours alone. Once you mark a crawl
          completed, anyone who can see your profile can see it.
        </p>
      ) : (
        <p className="pc-privacy">
          Crawls {displayName} has walked. Open one to see the route, or recreate
          it as your own.
        </p>
      )}
    </section>
  )
}

const STATUS_LABEL: Record<Crawl['status'], string> = {
  draft: 'Draft',
  planned: 'Planned',
  completed: 'Completed',
}

/**
 * "Want to do" — completed crawls by other people that you bookmarked.
 *
 * Only on your own profile: saves are private. Separate from Crawls because
 * these are not yours — a bookmark is a pointer to somebody else's route, and
 * recreating one is what turns it into a crawl of your own.
 */
export function ProfileSavedCrawls({ saved }: { saved: SavedCrawl[] }) {
  return (
    <section className="pc-block">
      <div className="pc-head">
        <h2 className="pc-title">Want to do</h2>
      </div>

      {saved.length === 0 ? (
        <p className="pc-empty">
          Crawls you mark &ldquo;want to do this&rdquo; on other people&rsquo;s
          profiles will be kept here.
        </p>
      ) : (
        <ul className="pc-list">
          {saved.map((crawl) => (
            <li key={crawl.id} className="pc-row">
              <Link href={`/map?crawl=${crawl.id}`} className="pc-row-link">
                <span className="pc-row-title">{crawl.title}</span>
                <span className="pc-row-meta">
                  {crawl.owner_username && (
                    <span>by {crawl.owner_display_name || `@${crawl.owner_username}`}</span>
                  )}
                  <span>
                    {crawl.stop_count} stop{crawl.stop_count === 1 ? '' : 's'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="pc-privacy">Only you can see what you&rsquo;ve saved.</p>
    </section>
  )
}
