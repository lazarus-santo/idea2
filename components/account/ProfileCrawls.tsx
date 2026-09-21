import Link from 'next/link'
import type { Crawl } from '@/lib/crawl-types'
import '@/app/crawls.css'

/**
 * Somebody's saved crawls, on their profile.
 *
 * ── WHY THIS ONLY EVER RENDERS ON YOUR OWN PROFILE ─────────────────────────
 *
 * A crawl is owner-only in this phase — migration_v66's policies are strictly
 * first-person and there is no can_view_profile() call anywhere in the crawl
 * code. So the profile page renders this for its owner and for nobody else,
 * and there is no "locked" state to show a visitor because there is nothing
 * there to lock: another account's read returns no rows at all.
 *
 * That is why this takes no `isOwnProfile` prop to branch on, unlike
 * ProfileLog and ProfileTopFour beside it. Those two describe a person to a
 * visitor and have to decide how much to say. This one is not shown to
 * visitors, so a prop deciding what a visitor sees would be a branch that
 * never runs — and a branch that never runs is one nobody notices is wrong
 * when Phase 2 makes crawls shareable. Phase 2 adds the audience and the gate
 * together, deliberately.
 *
 * ── EVERY ROW OPENS THE MAP ────────────────────────────────────────────────
 *
 * There is no crawl page to link to any more. A crawl is built on /map, so a
 * saved one opens there too — ?crawl=<id> loads its stops into the itinerary,
 * editable, the same screen it was made on. A second read-only view would be a
 * second place the route is drawn, and the two would drift.
 */
export default function ProfileCrawls({ crawls }: { crawls: Crawl[] }) {
  return (
    <section className="pc-block">
      <div className="pc-head">
        <h2 className="pc-title">Crawls</h2>
        <Link href="/map" className="pc-new">Plan one</Link>
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
                  <span className={`pc-badge pc-badge--${crawl.status}`}>
                    {crawl.status === 'draft' ? 'Draft' : 'Planned'}
                  </span>
                  <span>
                    {crawl.stop_count} stop{crawl.stop_count === 1 ? '' : 's'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="pc-privacy">
        Crawls are yours alone for now — nobody else can see them, including
        people who follow you.
      </p>
    </section>
  )
}
