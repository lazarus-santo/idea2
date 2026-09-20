'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import {
  saveTopFourExhibitions,
  saveTopFourContent,
} from '@/lib/top-four-writes'
import { TOP_FOUR_SIZE, type TopFourCandidate } from '@/lib/top-four-types'

/**
 * Picking and arranging one Top Four.
 *
 * ── THIS IS THE ARRANGING SURFACE, NOT THE ONLY WAY IN ──────────────────────
 *
 * Adding a single item happens where the item is: AddToTopFour sits on the log
 * entry of a show or an article, one click, no panel. This panel is for the
 * thing that cannot be done one item at a time — deciding what order the four
 * go in — and for picking several at once when somebody is setting the list up
 * for the first time.
 *
 * The two paths meet in the database: the per-item functions compose a new
 * list and hand it to the same whole-list function this panel calls. Nothing
 * here needs to know the other exists.
 *
 * ── ONE COMPONENT FOR BOTH LISTS ────────────────────────────────────────────
 *
 * It does not know whether it is holding shows or articles, and it does not
 * need to: a candidate is a key, a title and a subtitle, and the thing that
 * gets saved is the order of the keys. `kind` chooses which writer to call and
 * supplies the nouns. Two near-identical editors would have been two places to
 * fix the next reordering bug.
 *
 * ── WHY IT HOLDS A DRAFT AND SAVES ONCE ─────────────────────────────────────
 *
 * The database takes the whole list or nothing — see lib/top-four-writes.ts —
 * so rearranging locally and saving at the end is not a convenience layered on
 * top, it is the shape of the write. It is also the honest UI: moving an item
 * from fourth to first is one decision, and saving each ↑ separately would
 * write three orders the person never chose.
 *
 * Cancel therefore genuinely undoes, because nothing was written.
 *
 * ── THE CANDIDATE LIST IS ALREADY FILTERED, AND THAT IS NOT THE GATE ────────
 *
 * Only items logged as seen/read are offered. The database enforces that
 * independently — migration_v64 makes it a foreign key into the log plus a
 * status trigger — and would refuse anything else. Filtering here is the
 * ordinary courtesy of not offering somebody an error.
 *
 * The one case where the two can disagree is a list that went stale: the
 * editor is open in this tab while the item is downgraded in another. The save
 * is then refused, and explain() in the writer turns that into "reload and try
 * again" rather than a constraint name. That is the right outcome — the
 * database is the one that is right.
 *
 * ── ↑/↓ RATHER THAN DRAG ────────────────────────────────────────────────────
 *
 * Four slots do not need a drag library, and buttons work with a keyboard and
 * a screen reader without anything extra.
 */
export default function TopFourEditor({
  kind,
  candidates,
  initial,
}: {
  kind: 'exhibitions' | 'content'
  candidates: TopFourCandidate[]
  /** The keys currently in the list, in slot order. */
  initial: string[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string[]>(initial)
  const [filter, setFilter] = useState('')

  const nouns =
    kind === 'exhibitions'
      ? { one: 'show', many: 'shows', empty: 'No shows marked as seen yet.' }
      : { one: 'article', many: 'articles', empty: 'Nothing marked as read yet.' }

  const working = busy || pending

  const byKey = useMemo(
    () => new Map(candidates.map((c) => [c.key, c])),
    [candidates]
  )

  // Everything eligible that is not already in the list, optionally narrowed by
  // the filter box. The filter looks at the subtitle too, so "Gagosian" finds a
  // show by its venue and "Artforum" finds a piece by its publication.
  const available = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return candidates
      .filter((c) => !chosen.includes(c.key))
      .filter(
        (c) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          (c.subtitle ?? '').toLowerCase().includes(q)
      )
  }, [candidates, chosen, filter])

  const full = chosen.length >= TOP_FOUR_SIZE

  function move(from: number, to: number) {
    if (to < 0 || to >= chosen.length) return
    const next = [...chosen]
    // Lift and reinsert, which is a swap for adjacent slots and stays correct
    // if this is ever wired to something that moves further than one place.
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setChosen(next)
  }

  function add(key: string) {
    if (full || chosen.includes(key)) return
    setChosen([...chosen, key])
  }

  function drop(key: string) {
    setChosen(chosen.filter((k) => k !== key))
  }

  async function save() {
    setBusy(true)
    setError(null)

    const { error } =
      kind === 'exhibitions'
        ? await saveTopFourExhibitions(getSupabaseBrowser(), chosen)
        : await saveTopFourContent(getSupabaseBrowser(), chosen)

    setBusy(false)

    if (error) {
      setError(error.message)
      // Deliberately stays open with the draft intact: the person may be able
      // to fix it by removing the offending item, and throwing the arrangement
      // away would be a second loss on top of the failure.
      return
    }

    setOpen(false)
    // Re-read rather than patch local state. The list is server-rendered from
    // the same function that decides privacy, so asking again is both simpler
    // and more honest than predicting what the database did.
    startTransition(() => router.refresh())
  }

  function cancel() {
    setChosen(initial)
    setFilter('')
    setError(null)
    setOpen(false)
  }

  if (!open) {
    return (
      <button type="button" className="tf-edit" onClick={() => setOpen(true)}>
        {initial.length ? 'Edit' : 'Choose'}
      </button>
    )
  }

  return (
    <div className="tf-editor">
      <div className="tf-editor-head">
        <p className="tf-editor-title">
          Your top four {nouns.many}
          <span className="tf-editor-count">
            {chosen.length} of {TOP_FOUR_SIZE}
          </span>
        </p>
      </div>

      {chosen.length === 0 ? (
        <p className="tf-editor-empty">
          Nothing picked yet. Add up to four from the list below.
        </p>
      ) : (
        <ol className="tf-chosen">
          {chosen.map((key, i) => {
            const item = byKey.get(key)
            return (
              <li key={key} className="tf-chosen-row">
                <span className="tf-chosen-rank">{i + 1}</span>
                <span className="tf-chosen-text">
                  {/* A key with no candidate behind it should not happen — the
                      list is seeded from the same logs. If it ever does, the
                      slot still renders and can still be removed, rather than
                      crashing the editor over a missing title. */}
                  <span className="tf-chosen-title">{item?.title ?? 'This item'}</span>
                  {item?.subtitle && (
                    <span className="tf-chosen-sub">{item.subtitle}</span>
                  )}
                </span>
                <span className="tf-chosen-actions">
                  <button
                    type="button"
                    className="tf-move"
                    onClick={() => move(i, i - 1)}
                    disabled={i === 0 || working}
                    aria-label={`Move ${item?.title ?? nouns.one} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="tf-move"
                    onClick={() => move(i, i + 1)}
                    disabled={i === chosen.length - 1 || working}
                    aria-label={`Move ${item?.title ?? nouns.one} down`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="tf-move tf-move--drop"
                    onClick={() => drop(key)}
                    disabled={working}
                    aria-label={`Remove ${item?.title ?? nouns.one}`}
                  >
                    ✕
                  </button>
                </span>
              </li>
            )
          })}
        </ol>
      )}

      <div className="tf-pick">
        <label className="tf-pick-label" htmlFor={`tf-filter-${kind}`}>
          {full
            ? `Remove one to add another.`
            : `Add from the ${nouns.many} you have logged`}
        </label>
        {/* The filter stays usable when the list is full, so somebody can look
            something up before deciding what to drop. */}
        <input
          id={`tf-filter-${kind}`}
          className="tf-filter"
          type="search"
          value={filter}
          placeholder="Search"
          onChange={(e) => setFilter(e.target.value)}
        />

        {candidates.length === 0 ? (
          <p className="tf-editor-empty">{nouns.empty}</p>
        ) : available.length === 0 ? (
          <p className="tf-editor-empty">
            {filter.trim() ? 'Nothing matches that.' : 'Everything you have logged is already in.'}
          </p>
        ) : (
          <ul className="tf-available">
            {available.map((c) => (
              <li key={c.key} className="tf-available-row">
                <span className="tf-chosen-text">
                  <span className="tf-chosen-title">{c.title}</span>
                  {c.subtitle && <span className="tf-chosen-sub">{c.subtitle}</span>}
                </span>
                <button
                  type="button"
                  className="tf-add"
                  onClick={() => add(c.key)}
                  disabled={full || working}
                  aria-label={`Add ${c.title}`}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="tf-error">{error}</p>}

      <div className="tf-editor-actions">
        <button type="button" className="tf-save" onClick={save} disabled={working}>
          {working ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="tf-cancel" onClick={cancel} disabled={working}>
          Cancel
        </button>
      </div>
    </div>
  )
}
