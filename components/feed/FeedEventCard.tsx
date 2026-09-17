'use client'

import Link from 'next/link'
import { profileDisplayName, profilePath } from '@/lib/profile'
import type { FeedEvent } from '@/lib/feed-types'
import { rendererFor } from './renderers'

/**
 * The frame every event is drawn in: who did it, when, and — from the registry
 * — what they did.
 *
 * The split is the point. This component owns everything that is true of all
 * events, so the avatar, the name, the link to the profile and the timestamp
 * look the same across types and cannot drift apart as types are added. The
 * renderer owns only the part that differs. Adding an event type therefore
 * means writing a sentence, not another card.
 */

/** "4m", "3h", "2d", then a date. Compact because it sits beside the name. */
function relativeTime(iso: string): { label: string; exact: string } {
  const then = new Date(iso)
  const exact = then.toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })

  const seconds = Math.floor((Date.now() - then.getTime()) / 1000)

  // A clock skew between the browser and the database can put an event a few
  // seconds in the future. "in 3 seconds" on an activity feed reads as a bug,
  // so anything under a minute either way is just "now".
  if (seconds < 60) return { label: 'now', exact }
  if (seconds < 3600) return { label: `${Math.floor(seconds / 60)}m`, exact }
  if (seconds < 86400) return { label: `${Math.floor(seconds / 3600)}h`, exact }
  if (seconds < 604800) return { label: `${Math.floor(seconds / 86400)}d`, exact }

  return {
    label: then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    exact,
  }
}

export default function FeedEventCard({ event }: { event: FeedEvent }) {
  /*
   * react-hooks/static-components fires on any component reached through a
   * lookup, because a component BUILT during render gets a new identity every
   * time and silently resets its own state. That is not what happens here:
   * FEED_RENDERERS is a module-level constant, so the reference this returns is
   * the same object on every render for a given type, and the only way it
   * changes is if the event's type changes — in which case remounting is the
   * correct behaviour anyway.
   *
   * Disabled rather than worked around, because the two obvious workarounds are
   * both worse. Calling the renderer as a plain function would bar it from ever
   * using a hook, which rules out something as ordinary as a "show more" toggle
   * inside one event. A switch statement over known types would put the list of
   * event types in this file as well as the registry, which is the coupling the
   * whole design exists to avoid.
   */
  const Renderer = rendererFor(event.type)
  const name = profileDisplayName(event)
  const time = relativeTime(event.created_at)

  return (
    <li className="fd-event">
      <Link href={profilePath(event.username)} className="fd-event-avatar-link" tabIndex={-1} aria-hidden="true">
        {event.avatar_url
          // eslint-disable-next-line @next/next/no-img-element
          ? <img className="ac-avatar fd-event-avatar" src={event.avatar_url} alt="" />
          : (
            <div className="ac-avatar fd-event-avatar ac-avatar--placeholder">
              {name.charAt(0).toUpperCase()}
            </div>
          )}
      </Link>

      <div className="fd-event-main">
        <p className="fd-event-head">
          <Link href={profilePath(event.username)} className="fd-event-actor">{name}</Link>
          {/* The full timestamp is the title, so the compact label stays
              readable and the exact time is still available on hover. */}
          <time className="fd-event-time" dateTime={event.created_at} title={time.exact}>
            {time.label}
          </time>
        </p>

        {/* eslint-disable-next-line react-hooks/static-components */}
        <Renderer event={event} />
      </div>
    </li>
  )
}
