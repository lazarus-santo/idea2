/**
 * End-to-end check of migration_v62: the exhibition log.
 *
 *   node --env-file=.env.local scripts/test-exhibition-logs.mjs
 *
 * RUN IT AFTER PASTING supabase/migration_v62.sql INTO THE SQL EDITOR. It
 * talks to the live database over the REST API with real signed-in sessions,
 * which is the only way to exercise any of this: the SQL editor runs as
 * postgres and bypasses every policy and every grant the migration is made of.
 * A CHECK constraint would still fire there, but nothing else would.
 *
 * It creates four throwaway accounts of its own and deletes them at the end,
 * in a finally block, so a failure halfway through still cleans up. It never
 * writes to a real account, and the only rows it creates outside its own
 * accounts are exhibition_logs rows belonging to them, which cascade away with
 * the profiles. It READS two real published exhibitions and changes neither.
 *
 * The four accounts, because the roles are what is being proved:
 *   A  a PUBLIC profile that logs things
 *   B  a PUBLIC profile that follows nobody — the stranger
 *   P  a PRIVATE profile that logs things
 *   F  a PUBLIC profile whose follow request P has approved
 *
 * WHAT IT DOES NOT COVER: a live rescrape. Section 10 proves the id-stability
 * MECHANISM — that Agent 1's match key finds the same row — without paying for
 * a scrape or touching a venue's website. Running a real one is a separate,
 * deliberate act: POST /api/admin/venues/<id>/scrape.
 */

import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !ANON || !SERVICE) {
  console.error('Missing Supabase env. Run with: node --env-file=.env.local')
  process.exit(1)
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

let passed = 0
let failed = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/** A signed-in client for one throwaway account. */
async function makeAccount(tag, privacy) {
  const email = `log-test-${tag}-${Date.now()}@example.invalid`
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createErr) throw new Error(`createUser(${tag}): ${createErr.message}`)

  const id = created.user.id
  const username = `logtest_${tag}_${id.slice(0, 6)}`

  const { error: profileErr } = await admin
    .from('profiles')
    .update({ username, display_name: `Log Test ${tag.toUpperCase()}`, privacy })
    .eq('id', id)
  if (profileErr) throw new Error(`profile(${tag}): ${profileErr.message}`)

  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`signIn(${tag}): ${signInErr.message}`)

  return { tag, id, username, client }
}

/** Write a whole log row the way lib/exhibition-log-writes.ts does. */
function saveLog(person, exhibitionId, row) {
  return person.client
    .from('exhibition_logs')
    .upsert(
      {
        user_id: person.id,
        exhibition_id: exhibitionId,
        status: row.status,
        rating: row.rating ?? null,
        liked: row.liked ?? false,
        comment: row.comment ?? null,
        comment_visibility: row.comment_visibility ?? null,
      },
      { onConflict: 'user_id,exhibition_id' }
    )
}

/** Read a person's own row back. */
async function readOwn(person, exhibitionId) {
  const { data } = await person.client
    .from('exhibition_logs')
    .select('status, rating, liked, comment, comment_visibility')
    .eq('user_id', person.id)
    .eq('exhibition_id', exhibitionId)
    .maybeSingle()
  return data
}

/** What `caller` can see of `target`'s log. `caller` null means signed out. */
async function logAsSeenBy(caller, targetId) {
  const client = caller
    ? caller.client
    : createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await client.rpc('profile_exhibition_logs', {
    profile_id: targetId,
  })
  if (error) throw new Error(`profile_exhibition_logs: ${error.message}`)
  return data ?? []
}

async function main() {
  const people = []

  try {
    section('Setting up')

    // Two real published shows at DIFFERENT venues, so section 8 can prove the
    // match key is venue-scoped rather than accidentally unique site-wide.
    const { data: shows, error: showErr } = await admin
      .from('exhibitions')
      .select('id, venue_id, show_title, detail_url, status, updated_at')
      .eq('status', 'published')
      .not('detail_url', 'is', null)
      .limit(2)
    if (showErr) throw new Error(`exhibitions: ${showErr.message}`)
    if (!shows || shows.length < 2) {
      throw new Error('Need two published exhibitions with a detail_url to test against.')
    }
    const [show, otherShow] = shows
    console.log(`  using "${show.show_title}" (${show.id})`)

    const [A, B, P, F] = await Promise.all([
      makeAccount('a', 'public'),
      makeAccount('b', 'public'),
      makeAccount('p', 'private'),
      makeAccount('f', 'public'),
    ])
    people.push(A, B, P, F)

    // F asks to follow P and P approves — the only way into a private profile.
    const { error: followErr } = await F.client
      .from('follows')
      .insert({ follower_id: F.id, followed_id: P.id })
    if (followErr) throw new Error(`follow: ${followErr.message}`)
    const { error: approveErr } = await P.client
      .from('follows')
      .update({ status: 'approved' })
      .eq('follower_id', F.id)
      .eq('followed_id', P.id)
    if (approveErr) throw new Error(`approve: ${approveErr.message}`)
    console.log('  F is an approved follower of P')

    // ───────────────────────────────────────────────────────────────────────
    section('1. Want to see / Seen persists')

    const { error: wantErr } = await saveLog(A, show.id, { status: 'want_to_see' })
    check('marking want_to_see is accepted', !wantErr, wantErr?.message)

    let row = await readOwn(A, show.id)
    check('want_to_see reads back', row?.status === 'want_to_see', JSON.stringify(row))

    const { error: seenErr } = await saveLog(A, show.id, {
      status: 'seen',
      rating: 4,
      liked: true,
      comment: 'A public note from A.',
      comment_visibility: 'public',
    })
    check('upgrading to seen with rating, like and note is accepted', !seenErr, seenErr?.message)

    row = await readOwn(A, show.id)
    check(
      'seen, rating 4, liked and the note all read back',
      row?.status === 'seen' && row?.rating === 4 && row?.liked === true &&
        row?.comment === 'A public note from A.' && row?.comment_visibility === 'public',
      JSON.stringify(row)
    )

    // ───────────────────────────────────────────────────────────────────────
    section('2. The gate REJECTS — it does not quietly tidy')

    const rejected = async (label, row) => {
      const { error } = await saveLog(A, otherShow.id, row)
      check(label, !!error, error ? undefined : 'the write was ACCEPTED')
    }

    await rejected('a rating at want_to_see is refused',
      { status: 'want_to_see', rating: 5 })
    await rejected('a like at want_to_see is refused',
      { status: 'want_to_see', liked: true })
    await rejected('a note at want_to_see is refused',
      { status: 'want_to_see', comment: 'nope', comment_visibility: 'public' })
    await rejected('a rating of 6 is refused',
      { status: 'seen', rating: 6 })
    await rejected('a rating of 0 is refused',
      { status: 'seen', rating: 0 })
    await rejected('a note with no visibility is refused',
      { status: 'seen', comment: 'nope' })
    await rejected('a visibility with no note is refused',
      { status: 'seen', comment_visibility: 'private' })
    await rejected('an invented status is refused',
      { status: 'maybe' })

    // Nothing above may have left a row behind.
    const strayRow = await readOwn(A, otherShow.id)
    check('none of the refused writes created a row', strayRow === null, JSON.stringify(strayRow))

    // ───────────────────────────────────────────────────────────────────────
    section('3. Going back to want_to_see clears the opinion')

    // The complete row, with explicit nulls — which is what the app sends and
    // the only thing the CHECK will accept for a row that already has a rating.
    const { error: downErr } = await saveLog(A, show.id, {
      status: 'want_to_see', rating: null, liked: false, comment: null, comment_visibility: null,
    })
    check('downgrading with explicit nulls is accepted', !downErr, downErr?.message)

    row = await readOwn(A, show.id)
    check(
      'rating, like and note are GONE, not hidden',
      row?.status === 'want_to_see' && row?.rating === null &&
        row?.liked === false && row?.comment === null,
      JSON.stringify(row)
    )

    // And the documented consequence: a PARTIAL downgrade fails loudly rather
    // than silently keeping an opinion on a show you have not seen.
    await saveLog(A, show.id, {
      status: 'seen', rating: 3, liked: false, comment: null, comment_visibility: null,
    })
    const { error: partialErr } = await A.client
      .from('exhibition_logs')
      .update({ status: 'want_to_see' })
      .eq('user_id', A.id)
      .eq('exhibition_id', show.id)
    check('a PARTIAL downgrade that leaves a rating behind is refused',
      !!partialErr, partialErr ? undefined : 'the write was ACCEPTED')

    // ───────────────────────────────────────────────────────────────────────
    section('4. One row per person per exhibition')

    const { error: dupErr } = await A.client
      .from('exhibition_logs')
      .insert({ user_id: A.id, exhibition_id: show.id, status: 'seen' })
    check('a second insert for the same pair is refused', !!dupErr, dupErr ? undefined : 'ACCEPTED')

    const { count } = await admin
      .from('exhibition_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', A.id)
      .eq('exhibition_id', show.id)
    check('exactly one row exists for that pair', count === 1, `count=${count}`)

    // ───────────────────────────────────────────────────────────────────────
    section('5. Nobody reads anybody else\'s row from the table')

    const { data: peeked } = await B.client
      .from('exhibition_logs')
      .select('user_id, exhibition_id, comment')
      .eq('user_id', A.id)
    check('B cannot select A\'s rows directly', (peeked ?? []).length === 0,
      `${(peeked ?? []).length} rows came back`)

    const { error: forgeErr } = await B.client
      .from('exhibition_logs')
      .insert({ user_id: A.id, exhibition_id: otherShow.id, status: 'seen' })
    check('B cannot write a row as A', !!forgeErr, forgeErr ? undefined : 'ACCEPTED')

    // ───────────────────────────────────────────────────────────────────────
    section('6. Comment visibility, nested inside profile privacy')

    // A is PUBLIC. One show with a public note, one with a private note.
    await saveLog(A, show.id, {
      status: 'seen', rating: 5, liked: true,
      comment: 'A public note from A.', comment_visibility: 'public',
    })
    await saveLog(A, otherShow.id, {
      status: 'seen', comment: 'A PRIVATE note from A.', comment_visibility: 'private',
    })

    const aSeenByB = await logAsSeenBy(B, A.id)
    const aPublic = aSeenByB.find((e) => e.exhibition_id === show.id)
    const aPrivate = aSeenByB.find((e) => e.exhibition_id === otherShow.id)

    check('a stranger sees a public profile\'s log', aSeenByB.length === 2, `${aSeenByB.length} rows`)
    check('a public note on a public profile is readable',
      aPublic?.comment === 'A public note from A.', JSON.stringify(aPublic))
    check('a PRIVATE note is withheld from a stranger',
      aPrivate !== undefined && aPrivate.comment === null, JSON.stringify(aPrivate))
    check('the withheld note does not announce itself via visibility',
      aPrivate?.comment_visibility === null, JSON.stringify(aPrivate?.comment_visibility))
    check('the rating and like are still visible alongside the withheld note',
      aPublic?.rating === 5 && aPublic?.liked === true, JSON.stringify(aPublic))

    const aSeenByA = await logAsSeenBy(A, A.id)
    check('A can read A\'s own private note',
      aSeenByA.find((e) => e.exhibition_id === otherShow.id)?.comment === 'A PRIVATE note from A.')
    check('A\'s own private note is labelled private to A',
      aSeenByA.find((e) => e.exhibition_id === otherShow.id)?.comment_visibility === 'private')

    const aSeenByAnon = await logAsSeenBy(null, A.id)
    check('a signed-out visitor sees a public profile\'s public note',
      aSeenByAnon.find((e) => e.exhibition_id === show.id)?.comment === 'A public note from A.')
    check('a signed-out visitor cannot read a private note',
      aSeenByAnon.find((e) => e.exhibition_id === otherShow.id)?.comment === null)

    // ───────────────────────────────────────────────────────────────────────
    section('7. A PUBLIC note on a PRIVATE profile is not public')

    // This is the rule the brief named explicitly.
    await saveLog(P, show.id, {
      status: 'seen', rating: 3,
      comment: 'A PUBLIC note on a PRIVATE profile.', comment_visibility: 'public',
    })
    await saveLog(P, otherShow.id, {
      status: 'seen',
      comment: 'A private note on a private profile.', comment_visibility: 'private',
    })

    const pSeenByB = await logAsSeenBy(B, P.id)
    check('a non-follower sees NOTHING of a private profile\'s log',
      pSeenByB.length === 0, `${pSeenByB.length} rows came back`)

    const pSeenByAnon = await logAsSeenBy(null, P.id)
    check('a signed-out visitor sees nothing of a private profile\'s log',
      pSeenByAnon.length === 0, `${pSeenByAnon.length} rows came back`)

    const pSeenByF = await logAsSeenBy(F, P.id)
    check('an APPROVED follower sees the private profile\'s log',
      pSeenByF.length === 2, `${pSeenByF.length} rows`)
    check('the approved follower reads the public note',
      pSeenByF.find((e) => e.exhibition_id === show.id)?.comment ===
        'A PUBLIC note on a PRIVATE profile.')
    check('the approved follower does NOT read the private note',
      pSeenByF.find((e) => e.exhibition_id === otherShow.id)?.comment === null)

    // ───────────────────────────────────────────────────────────────────────
    section('8. A block closes the log too')

    // B logs something first, or "the blocker sees nothing" would pass for the
    // boring reason that there was never anything to see.
    await saveLog(B, show.id, {
      status: 'seen', comment: 'A public note from B.', comment_visibility: 'public',
    })
    check('B\'s log is visible to A before any block',
      (await logAsSeenBy(A, B.id)).length === 1)

    const { error: blockErr } = await A.client
      .from('blocks')
      .insert({ blocker_id: A.id, blocked_id: B.id })
    if (blockErr) throw new Error(`block: ${blockErr.message}`)

    check('a blocked account sees none of the blocker\'s log',
      (await logAsSeenBy(B, A.id)).length === 0)
    check('the blocker sees none of the blocked account\'s log',
      (await logAsSeenBy(A, B.id)).length === 0)

    await A.client.from('blocks').delete().eq('blocker_id', A.id).eq('blocked_id', B.id)
    check('unblocking restores the log',
      (await logAsSeenBy(B, A.id)).length === 2)

    // ───────────────────────────────────────────────────────────────────────
    section('9. Only published shows can be logged')

    const { data: pendingShow } = await admin
      .from('exhibitions')
      .select('id')
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle()

    if (pendingShow) {
      const { error: pendingErr } = await saveLog(A, pendingShow.id, { status: 'want_to_see' })
      check('logging an unpublished show is refused', !!pendingErr,
        pendingErr ? undefined : 'ACCEPTED')
    } else {
      console.log('  – skipped: no pending exhibition to try (nothing unreviewed right now)')
    }

    const { error: ghostErr } = await saveLog(
      A, '00000000-0000-0000-0000-000000000000', { status: 'want_to_see' })
    check('logging a show that does not exist is refused', !!ghostErr,
      ghostErr ? undefined : 'ACCEPTED')

    // ───────────────────────────────────────────────────────────────────────
    section('10. The log survives a rescrape — the id-stability mechanism')

    // Agent 1 matches a scraped show to its row on (venue_id, detail_url)
    // before it considers inserting anything (lib/scraper.ts step 3). This asks
    // that lookup the same question a rescrape would and checks it lands on the
    // row the log points at. It does not run a scrape: no venue is fetched and
    // no exhibition row is written.
    const { data: rematched } = await admin
      .from('exhibitions')
      .select('id')
      .eq('venue_id', show.venue_id)
      .eq('detail_url', show.detail_url)
      .maybeSingle()

    check('Agent 1\'s match key still finds the logged show',
      rematched?.id === show.id, `matched ${rematched?.id} instead of ${show.id}`)

    check('the logged exhibition has a detail_url, so it is matched by URL and never by title',
      !!show.detail_url)

    // A rescrape UPDATES that row in place rather than replacing it. Running an
    // UPDATE over the same row proves the log's foreign key survives that.
    //
    // updated_at is written back to the value it already holds — a real UPDATE
    // that changes nothing. This script runs against PRODUCTION and the row
    // belongs to a real exhibition, so it may exercise the path but must not
    // leave a mark on it. (`last_fetched_at` was tried here first and does not
    // exist: it is from supabase/schema.sql, which is the v1 schema and long
    // out of date. Read column names off a live row, not out of that file.)
    const { error: touchErr } = await admin
      .from('exhibitions')
      .update({ updated_at: show.updated_at })
      .eq('id', show.id)
    check('the matched row updates in place', !touchErr, touchErr?.message)

    const afterRow = await readOwn(A, show.id)
    check('the log still resolves to the same exhibition after the update',
      afterRow?.status === 'seen', JSON.stringify(afterRow))

    const afterList = await logAsSeenBy(B, A.id)
    check('and it still renders with its title on the profile',
      afterList.find((e) => e.exhibition_id === show.id)?.show_title === show.show_title)

  } finally {
    section('Cleaning up')
    for (const p of people) {
      // Deleting the account cascades to profiles, follows, blocks and the log
      // rows this script wrote. Nothing it touched outlives it.
      const { error } = await admin.auth.admin.deleteUser(p.id)
      if (error) console.log(`  ! could not delete ${p.tag}: ${error.message}`)
    }
    console.log(`  removed ${people.length} throwaway accounts`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`)
  process.exit(1)
})
