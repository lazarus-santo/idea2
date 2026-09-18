'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import type { RelationshipPerson } from '@/lib/relationships'

/**
 * The blocked list and the muted list, in Settings.
 *
 * THIS IS THE ONLY PLACE AN UNBLOCK CAN LIVE, and that follows from what a
 * block does rather than from a layout preference. Once you block somebody
 * their profile stops existing for you — public.profile_card() returns no row,
 * so /u/<handle> 404s — which means the profile page cannot hold the undo for
 * an action that removes the page. Muting has no such problem and can be undone
 * from either place; it is here as well so both lists read the same way.
 *
 * THESE TWO LISTS ARE THE MOST PRIVATE THING IN THE APP. Nobody sees them but
 * their owner: public.blocks and public.mutes have no read policy for the
 * person on the receiving end, so being blocked is not something you can look
 * up, and the functions that fill these lists take no argument and answer only
 * about their caller. Being able to read your own list is the whole of the
 * access anyone has to either table.
 *
 * UNBLOCKING RESTORES VISIBILITY AND NOTHING ELSE. The follows severed when the
 * block was made are gone, not flagged — there is deliberately nothing stored
 * to restore from. If they want to follow again it is a fresh follow, or a
 * fresh request if the account is private. The copy below says so, because the
 * alternative is people discovering it by being surprised.
 */
export default function RelationshipLists({
  blocked,
  muted,
}: {
  blocked: RelationshipPerson[]
  muted: RelationshipPerson[]
}) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function undo(kind: 'block' | 'mute', personId: string) {
    setBusyId(personId)
    setError(null)

    const supabase = getSupabaseBrowser()
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) {
      setError('Sign in again to do that.')
      setBusyId(null)
      return
    }

    // Both statements are scoped to rows YOU made, which is also the only
    // thing the policies in migration_v48 would permit.
    const { error } =
      kind === 'block'
        ? await supabase.from('blocks').delete()
            .eq('blocker_id', auth.user.id).eq('blocked_id', personId)
        : await supabase.from('mutes').delete()
            .eq('muter_id', auth.user.id).eq('muted_id', personId)

    if (error) {
      setError(error.message)
      setBusyId(null)
      return
    }

    setBusyId(null)
    router.refresh()
  }

  // Nothing blocked and nothing muted is the ordinary case, and an empty
  // section for each would be two headings about things the person has never
  // done. The section appears when it has something in it.
  if (blocked.length === 0 && muted.length === 0) return null

  return (
    <>
      {/* The blocked section is ANCHORED: blocking from a profile page sends
          you straight to #blocked, because it has just removed the page you
          would otherwise undo it from. See RelationshipMenu. */}
      {blocked.length > 0 && (
        <section className="ac-section" id="blocked">
          <h2 className="ac-section-title">Blocked ({blocked.length})</h2>
          <p className="ac-meta" style={{ marginBottom: 8 }}>
            You and these accounts cannot find each other in search or open each
            other&rsquo;s profiles. Unblocking undoes that — it does not restore
            anyone&rsquo;s follow.
          </p>
          <List
            people={blocked}
            actionLabel="Unblock"
            busyId={busyId}
            onAct={(id) => undo('block', id)}
            /* No link: their profile 404s while the block stands, so a link
               here would be a dead end the person just pressed. */
            linked={false}
          />
        </section>
      )}

      {muted.length > 0 && (
        <section className="ac-section" id="muted">
          <h2 className="ac-section-title">Muted ({muted.length})</h2>
          <p className="ac-meta" style={{ marginBottom: 8 }}>
            Their activity stays out of your feed. Nothing else changed, and
            they were not told.
          </p>
          <List
            people={muted}
            actionLabel="Unmute"
            busyId={busyId}
            onAct={(id) => undo('mute', id)}
            linked
          />
        </section>
      )}

      {error && <p className="ac-error">{error}</p>}
    </>
  )
}

function List({
  people,
  actionLabel,
  busyId,
  onAct,
  linked,
}: {
  people: RelationshipPerson[]
  actionLabel: string
  busyId: string | null
  onAct: (personId: string) => void
  linked: boolean
}) {
  return (
    <ul className="ac-people">
      {people.map((p) => {
        const name = p.display_name?.trim() || p.username
        const body = (
          <>
            {p.avatar_url
              // eslint-disable-next-line @next/next/no-img-element
              ? <img className="ac-avatar" src={p.avatar_url} alt="" />
              : (
                <div className="ac-avatar ac-avatar--placeholder">
                  {name.charAt(0).toUpperCase()}
                </div>
              )}
            <span className="ac-person-names">
              <span className="ac-person-name">{name}</span>
              <span className="ac-person-handle">@{p.username}</span>
            </span>
          </>
        )

        return (
          <li className="ac-person" key={p.id}>
            {linked
              ? <Link className="ac-person-main" href={`/u/${p.username}`}>{body}</Link>
              : <span className="ac-person-main">{body}</span>}

            <span className="ac-person-actions">
              <button
                type="button"
                className="ac-btn ac-btn--secondary ac-btn--inline ac-btn--small"
                onClick={() => onAct(p.id)}
                disabled={busyId === p.id}
              >
                {busyId === p.id ? '…' : actionLabel}
              </button>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
