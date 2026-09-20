/**
 * End-to-end check of the Top Four lists — migration_v64 AND migration_v65.
 *
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs scripts/test-top-four.mjs
 *
 * RUN IT AFTER PASTING BOTH supabase/migration_v64.sql (the tables, the
 * eligibility rules and the whole-list functions) AND supabase/migration_v65.sql
 * (the per-item wrappers) INTO THE SQL EDITOR. Applying only the first is not a
 * hypothetical: it happened, and sections 10 and 11 are what caught it. Like
 * the Phase 1 and Phase 2 scripts it talks to the live database over the REST
 * API with real signed-in sessions, which is the only way to exercise any of
 * this: the SQL editor runs as postgres and bypasses every policy and grant
 * the migration is made of.
 *
 * THAT MATTERS MORE HERE THAN IT DID IN EITHER EARLIER PHASE. Half of this
 * design is an ABSENCE — there are no INSERT, UPDATE or DELETE grants on
 * either table, so the only way in is the two set functions. An absent grant
 * is invisible to postgres, so a check run in the editor would pass whether
 * the design held or not. Section 9 is the one that proves it, and it can only
 * be proved from a real session.
 *
 * ── WHAT IT WRITES TO PRODUCTION ────────────────────────────────────────────
 *
 * Four throwaway accounts, deleted in a finally block so a failure halfway
 * through still cleans up, taking their logs and Top Fours with them through
 * the cascades.
 *
 * AND, as in Phase 2, a throwaway `prereads` row on one real published
 * exhibition — because a preread has to exist to be logged, ranked and frozen,
 * and freezing a REAL one would leave a genuine article hidden behind a test —
 * plus the replacement row the freeze itself creates. Both are deleted in the
 * same finally block. They are briefly visible on that exhibition's page while
 * the script runs. Real exhibitions, prereads and readings are otherwise READ
 * and never written.
 *
 * ── THE TWO WRITE PATHS ARE BOTH EXERCISED ──────────────────────────────────
 *
 * Sections 1-9 drive the WHOLE-LIST functions from migration_v64, which is what
 * the reorder panel calls. Sections 10 and 11 drive the PER-ITEM ones from
 * migration_v65, behind the "Add to Top Four" button on a log entry. They are
 * not independent implementations — the per-item functions compose a list and
 * call the whole-list ones — but they are separate entry points with their own
 * refusals, so both are proved, and a missing v65 shows up as 35 red
 * assertions in 10 and 11 while 1-9 stay green.
 */

import { createClient } from '@supabase/supabase-js'
import { replacementInsert, freezeUpdate } from '../lib/preread-writes.ts'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !ANON || !SERVICE) {
  console.error('Missing Supabase env. Run with: node --env-file=.env.local')
  process.exit(1)
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

const MARK = `ZZ TEST ROW — top-four test ${Date.now()} — safe to delete`

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

/**
 * A real refusal, and not merely a function PostgREST could not find.
 *
 * EVERY "is refused" check below asks this rather than `!!error`, and the
 * reason is a false green this suite actually produced.
 *
 * When the per-item functions had not been applied, calls to them came back as
 * errors — "Could not find the function ... in the schema cache" — and a check
 * written as `!!error` READ THAT AS THE GUARD WORKING. Eight assertions about
 * refusals passed while the thing doing the refusing did not exist. A missing
 * migration is precisely what this script is for, so a missing migration must
 * never be able to make it greener.
 *
 * The same reasoning covers a mistyped RPC name or a renamed argument: those
 * are bugs in the caller, and they should fail loudly here rather than
 * masquerade as the database holding the line.
 */
function refused(error) {
  if (!error) return false
  const m = error.message ?? ''
  return !m.includes('Could not find the function') && !m.includes('schema cache')
}

/** A signed-in client for one throwaway account. */
async function makeAccount(tag, privacy) {
  const email = `t4-test-${tag}-${Date.now()}@example.invalid`
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (createErr) throw new Error(`createUser(${tag}): ${createErr.message}`)

  const id = created.user.id
  const username = `t4test_${tag}_${id.slice(0, 6)}`

  const { error: profileErr } = await admin
    .from('profiles')
    .update({ username, display_name: `Top Four Test ${tag.toUpperCase()}`, privacy })
    .eq('id', id)
  if (profileErr) throw new Error(`profile(${tag}): ${profileErr.message}`)

  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`signIn(${tag}): ${signInErr.message}`)

  return { tag, id, username, client }
}

// ─── The writes, exactly as the app makes them ──────────────────────────────

/** Log an exhibition, whole-row as lib/exhibition-log-writes.ts does. */
function logShow(person, exhibitionId, status, extra = {}) {
  const seen = status === 'seen'
  return person.client.from('exhibition_logs').upsert(
    {
      user_id: person.id,
      exhibition_id: exhibitionId,
      status,
      rating: seen ? (extra.rating ?? null) : null,
      liked: seen ? (extra.liked ?? false) : false,
      comment: seen ? (extra.comment ?? null) : null,
      comment_visibility: seen ? (extra.comment_visibility ?? null) : null,
    },
    { onConflict: 'user_id,exhibition_id' }
  )
}

/** Log an article, whole-row as lib/reading-log-writes.ts does. */
function logRead(person, item, status, extra = {}) {
  const read = status === 'read'
  return person.client.from('reading_logs').upsert(
    {
      user_id: person.id,
      content_type: item.type,
      content_id: item.id,
      status,
      rating: read ? (extra.rating ?? null) : null,
      liked: read ? (extra.liked ?? false) : false,
      comment: read ? (extra.comment ?? null) : null,
      comment_visibility: read ? (extra.comment_visibility ?? null) : null,
    },
    { onConflict: 'user_id,content_type,content_id' }
  )
}

const setShows = (person, ids) =>
  person.client.rpc('set_top_four_exhibitions', { p_ids: ids })

const setReads = (person, items) =>
  person.client.rpc('set_top_four_content', {
    p_items: items.map((i) => ({ type: i.type, id: i.id })),
  })

// The per-item wrappers — what the "Add to Top Four" button on a log entry
// calls. They compose a new list and hand it to the two above, so these are
// not a second write path.
const addShow = (person, id) =>
  person.client.rpc('add_to_top_four_exhibition', { p_exhibition_id: id })

const dropShow = (person, id) =>
  person.client.rpc('remove_from_top_four_exhibition', { p_exhibition_id: id })

const addRead = (person, item) =>
  person.client.rpc('add_to_top_four_content', {
    p_content_type: item.type,
    p_content_id: item.id,
  })

const dropRead = (person, item) =>
  person.client.rpc('remove_from_top_four_content', {
    p_content_type: item.type,
    p_content_id: item.id,
  })

// ─── The reads ──────────────────────────────────────────────────────────────

/** What `caller` can see of `target`'s show Top Four. `caller` null = signed out. */
async function showsAsSeenBy(caller, targetId) {
  const client = caller
    ? caller.client
    : createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await client.rpc('profile_top_four_exhibitions', {
    profile_id: targetId,
  })
  if (error) throw new Error(`profile_top_four_exhibitions: ${error.message}`)
  return data ?? []
}

async function readsAsSeenBy(caller, targetId) {
  const client = caller
    ? caller.client
    : createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await client.rpc('profile_top_four_content', {
    profile_id: targetId,
  })
  if (error) throw new Error(`profile_top_four_content: ${error.message}`)
  return data ?? []
}

/** Their own rows, straight from the table under RLS. */
async function ownShows(person) {
  const { data, error } = await person.client
    .from('top_four_exhibitions')
    .select('exhibition_id, position, created_at')
    .eq('user_id', person.id)
    .order('position')
  if (error) throw new Error(`own top_four_exhibitions: ${error.message}`)
  return data ?? []
}

async function ownReads(person) {
  const { data, error } = await person.client
    .from('top_four_content')
    .select('content_type, content_id, position, created_at')
    .eq('user_id', person.id)
    .order('position')
  if (error) throw new Error(`own top_four_content: ${error.message}`)
  return data ?? []
}

/** The ids in slot order — the thing almost every assertion below is about. */
const orderOf = (rows) => rows.map((r) => r.exhibition_id)
const keysOf = (rows) => rows.map((r) => `${r.content_type}:${r.content_id}`)

async function main() {
  const people = []
  const madePrereads = []

  try {
    section('Setting up')

    // Six published exhibitions: four for a full list, a fifth to be refused
    // and to swap in as a replacement, and a sixth that is deliberately NEVER
    // logged — the per-item tests need an ineligible show to try to add.
    const { data: shows, error: showsErr } = await admin
      .from('exhibitions')
      .select('id, show_title')
      .eq('status', 'published')
      .limit(6)
    if (showsErr) throw new Error(`exhibitions: ${showsErr.message}`)
    if (!shows || shows.length < 6) throw new Error('Need six published exhibitions to test against.')
    const S = shows.map((s) => s.id)
    console.log(`  using ${shows.length} published exhibitions`)

    const { data: readings, error: readingErr } = await admin
      .from('readings')
      .select('id, headline')
      .order('created_at', { ascending: false })
      .limit(4)
    if (readingErr) throw new Error(`readings: ${readingErr.message}`)
    if (!readings || readings.length < 4) throw new Error('Need four readings to test against.')
    const R = readings.map((r) => ({ type: 'reading', id: r.id }))

    // A real published show to hang the throwaway prereads off.
    const { data: host, error: hostErr } = await admin
      .from('exhibitions')
      .select('id, show_title')
      .eq('status', 'published')
      .limit(1)
      .maybeSingle()
    if (hostErr) throw new Error(`host exhibition: ${hostErr.message}`)

    async function makePreread(suffix) {
      const { data, error } = await admin
        .from('prereads')
        .insert({
          exhibition_id: host.id,
          article_title: `${MARK} (${suffix})`,
          publication: 'Test Publication',
          article_url: `https://example.invalid/top-four-test/${Date.now()}-${suffix}`,
          row_status: 'active',
        })
        .select('id, article_title, publication, article_url')
        .single()
      if (error) throw new Error(`test preread (${suffix}): ${error.message}`)
      madePrereads.push(data.id)
      return data
    }

    const prereadRow = await makePreread('ranked')
    const preread = { type: 'preread', id: prereadRow.id }
    console.log(`  made a test preread on "${host.show_title}"`)

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
    // EXHIBITIONS AND ARTICLES ARE TESTED SEPARATELY THROUGHOUT, by name, the
    // way the brief asks and Phase 2 did: they are two tables with two triggers
    // and two functions, and a pass on one says nothing about the other.
    section('1. ELIGIBILITY — a show must be SEEN before it can be ranked')

    // Nothing logged at all: the foreign key is what refuses this one.
    const { error: unloggedErr } = await setShows(A, [S[0]])
    check('ranking a show with NO log at all is refused',
      refused(unloggedErr), unloggedErr?.message ?? 'the write was ACCEPTED')

    await logShow(A, S[0], 'want_to_see')
    const { error: wantErr } = await setShows(A, [S[0]])
    check('ranking a show logged only as want_to_see is refused',
      refused(wantErr), wantErr?.message ?? 'the write was ACCEPTED')
    check('...and the refusal names the status rule, not a constraint',
      (wantErr?.message ?? '').includes('top_four_not_seen'), wantErr?.message)

    check('nothing was written by either refusal', (await ownShows(A)).length === 0)

    await logShow(A, S[0], 'seen', { rating: 5, liked: true })
    const { error: seenErr } = await setShows(A, [S[0]])
    check('ranking it once marked SEEN is accepted', !seenErr, seenErr?.message)
    check('...and it lands in slot 1',
      JSON.stringify(await ownShows(A)).includes('"position":1'))

    // ───────────────────────────────────────────────────────────────────────
    section('2. ELIGIBILITY — an article must be READ before it can be ranked')

    const { error: unloggedReadErr } = await setReads(A, [R[0]])
    check('ranking an article with NO log at all is refused',
      refused(unloggedReadErr), unloggedReadErr?.message ?? 'the write was ACCEPTED')

    await logRead(A, R[0], 'reading_list')
    const { error: listErr } = await setReads(A, [R[0]])
    check('ranking an article logged only as reading_list is refused',
      refused(listErr), listErr?.message ?? 'the write was ACCEPTED')
    check('...and the refusal names the status rule',
      (listErr?.message ?? '').includes('top_four_not_read'), listErr?.message)

    check('nothing was written by either refusal', (await ownReads(A)).length === 0)

    await logRead(A, R[0], 'read', { rating: 4 })
    const { error: readOkErr } = await setReads(A, [R[0]])
    check('ranking it once marked READ is accepted', !readOkErr, readOkErr?.message)

    // A preread is the other content type, and has to be proved separately.
    await logRead(A, preread, 'read', { rating: 5, liked: true })
    const { error: prereadRankErr } = await setReads(A, [R[0], preread])
    check('a PREREAD can be ranked alongside a reading', !prereadRankErr, prereadRankErr?.message)
    check('both content types coexist in one list',
      keysOf(await ownReads(A)).join(',') === `reading:${R[0].id},preread:${preread.id}`,
      keysOf(await ownReads(A)).join(','))

    // ───────────────────────────────────────────────────────────────────────
    section('3. REORDERING AND REPLACING — the constraints must not fight it')

    // Log all four so a full list is possible.
    for (const id of S.slice(0, 4)) await logShow(A, id, 'seen')
    const { error: fourErr } = await setShows(A, [S[0], S[1], S[2], S[3]])
    check('a full list of four is accepted', !fourErr, fourErr?.message)
    check('...in the order given', orderOf(await ownShows(A)).join() === [S[0], S[1], S[2], S[3]].join())

    const beforeReorder = await ownShows(A)
    const pickedAt = Object.fromEntries(beforeReorder.map((r) => [r.exhibition_id, r.created_at]))

    // THE SWAP. Two adjacent items trade slots — the operation that a naive
    // row-at-a-time implementation cannot perform, because the one-per-slot
    // constraint refuses the intermediate state.
    const { error: swapErr } = await setShows(A, [S[1], S[0], S[2], S[3]])
    check('swapping slots 1 and 2 is accepted — no transient constraint conflict',
      !swapErr, swapErr?.message)
    check('...and the new order reads back',
      orderOf(await ownShows(A)).join() === [S[1], S[0], S[2], S[3]].join(),
      orderOf(await ownShows(A)).join())

    // A full reversal moves every single row, which is the worst case for any
    // scheme that tries to move rows one at a time.
    const { error: revErr } = await setShows(A, [S[3], S[2], S[1], S[0]])
    check('reversing the whole list is accepted', !revErr, revErr?.message)
    check('...and reads back reversed',
      orderOf(await ownShows(A)).join() === [S[3], S[2], S[1], S[0]].join(),
      orderOf(await ownShows(A)).join())

    // created_at survives a reorder: it is when the show was PICKED, not when
    // the list was last touched.
    const afterReorder = await ownShows(A)
    check('created_at is preserved across a reorder — it means "when I picked it"',
      afterReorder.every((r) => r.created_at === pickedAt[r.exhibition_id]),
      JSON.stringify(afterReorder.map((r) => r.created_at)))

    // Replacing one slot's occupant.
    await logShow(A, S[4], 'seen')
    const { error: replaceErr } = await setShows(A, [S[4], S[2], S[1], S[0]])
    check('replacing what is in slot 1 is accepted', !replaceErr, replaceErr?.message)
    check('...the new show is in slot 1 and the old one is gone entirely',
      orderOf(await ownShows(A)).join() === [S[4], S[2], S[1], S[0]].join(),
      orderOf(await ownShows(A)).join())

    const nowPicked = (await ownShows(A)).find((r) => r.exhibition_id === S[4])
    check('...and the newcomer gets a fresh created_at rather than inheriting one',
      !Object.values(pickedAt).includes(nowPicked?.created_at))

    // Shrinking and clearing.
    const { error: shrinkErr } = await setShows(A, [S[4], S[2]])
    check('shrinking the list to two is accepted', !shrinkErr, shrinkErr?.message)
    check('...and only two rows remain, in slots 1 and 2',
      (await ownShows(A)).map((r) => r.position).join() === '1,2')

    const { error: clearErr } = await setShows(A, [])
    check('an empty list clears the Top Four', !clearErr, clearErr?.message)
    check('...leaving no rows', (await ownShows(A)).length === 0)

    // Put it back for the rest of the script.
    await setShows(A, [S[0], S[1], S[2], S[3]])

    // ───────────────────────────────────────────────────────────────────────
    section('4. The same reorder guarantees for the ARTICLE list')

    for (const item of R) await logRead(A, item, 'read')
    const { error: fourReadsErr } = await setReads(A, [R[0], R[1], R[2], preread])
    check('a full list of four articles is accepted', !fourReadsErr, fourReadsErr?.message)

    const { error: readSwapErr } = await setReads(A, [preread, R[2], R[1], R[0]])
    check('reversing the article list is accepted — mixed types included',
      !readSwapErr, readSwapErr?.message)
    check('...and reads back reversed, with the preread first',
      keysOf(await ownReads(A)).join() ===
        [`preread:${preread.id}`, `reading:${R[2].id}`, `reading:${R[1].id}`, `reading:${R[0].id}`].join(),
      keysOf(await ownReads(A)).join())

    // ───────────────────────────────────────────────────────────────────────
    section('5. The list refuses to be more than four, or to hold anything twice')

    const { error: fiveErr } = await setShows(A, [S[0], S[1], S[2], S[3], S[4]])
    check('a list of five is refused', refused(fiveErr), fiveErr?.message ?? 'ACCEPTED')
    check('...naming the size rule',
      (fiveErr?.message ?? '').includes('top_four_too_many'), fiveErr?.message)

    const { error: dupErr } = await setShows(A, [S[0], S[0]])
    check('the same show in two slots is refused', refused(dupErr), dupErr?.message ?? 'ACCEPTED')
    check('...naming the duplicate rule',
      (dupErr?.message ?? '').includes('top_four_duplicate'), dupErr?.message)

    const { error: dupReadErr } = await setReads(A, [R[0], R[0]])
    check('the same article in two slots is refused',
      refused(dupReadErr), dupReadErr?.message ?? 'ACCEPTED')

    // A REFUSED WRITE MUST NOT EMPTY THE LIST. The set functions delete before
    // they insert, so this is the check that the whole thing is one
    // transaction and a failure rolls the delete back.
    check('a refused write leaves the PREVIOUS list intact — the delete rolled back',
      orderOf(await ownShows(A)).join() === [S[0], S[1], S[2], S[3]].join(),
      orderOf(await ownShows(A)).join())

    // The most dangerous version of that: a list where the LAST entry is
    // ineligible, so the delete and three inserts succeed before it fails.
    await logShow(A, S[4], 'want_to_see')
    const { error: lateErr } = await setShows(A, [S[1], S[2], S[3], S[4]])
    check('a list whose LAST entry is ineligible is refused', refused(lateErr), lateErr?.message ?? 'ACCEPTED')
    check('...and the previous list is still completely intact',
      orderOf(await ownShows(A)).join() === [S[0], S[1], S[2], S[3]].join(),
      orderOf(await ownShows(A)).join())
    await logShow(A, S[4], 'seen')

    // ───────────────────────────────────────────────────────────────────────
    section('6. DOWNGRADING a ranked show removes it from the Top Four')

    check('setup: four shows are ranked', (await ownShows(A)).length === 4)

    // The downgrade the app makes: a complete row with explicit nulls.
    const { error: downErr } = await logShow(A, S[1], 'want_to_see')
    check('downgrading a ranked show back to want_to_see is accepted',
      !downErr, downErr?.message)

    const afterDown = await ownShows(A)
    check('the downgraded show is GONE from the Top Four, automatically',
      !orderOf(afterDown).includes(S[1]), orderOf(afterDown).join())
    check('...and the other three are untouched',
      afterDown.length === 3 && orderOf(afterDown).join() === [S[0], S[2], S[3]].join(),
      orderOf(afterDown).join())

    // The slots do not renumber themselves, and that is deliberate: the
    // database stores what was chosen, and closing the gap is a decision for
    // whoever edits the list next.
    check('the remaining rows keep their original slot numbers',
      afterDown.map((r) => r.position).join() === '1,3,4',
      afterDown.map((r) => r.position).join())

    // DELETING the log entirely is the other path, and it is the foreign key's
    // cascade rather than the trigger that handles it.
    const { error: delErr } = await A.client
      .from('exhibition_logs')
      .delete()
      .eq('user_id', A.id)
      .eq('exhibition_id', S[3])
    check('removing the log entirely is accepted', !delErr, delErr?.message)
    check('...and the show leaves the Top Four through the FK cascade',
      !orderOf(await ownShows(A)).includes(S[3]), orderOf(await ownShows(A)).join())

    // ───────────────────────────────────────────────────────────────────────
    section('7. DOWNGRADING a ranked article does the same')

    check('setup: four articles are ranked', (await ownReads(A)).length === 4)

    const { error: readDownErr } = await logRead(A, R[2], 'reading_list')
    check('downgrading a ranked article back to reading_list is accepted',
      !readDownErr, readDownErr?.message)
    check('the downgraded article is GONE from the Top Four',
      !keysOf(await ownReads(A)).includes(`reading:${R[2].id}`),
      keysOf(await ownReads(A)).join())

    // And for a PREREAD, which is the other content type and the other branch
    // of the same trigger.
    const { error: prereadDownErr } = await logRead(A, preread, 'reading_list')
    check('downgrading a ranked PREREAD is accepted', !prereadDownErr, prereadDownErr?.message)
    check('...and it leaves the Top Four too',
      !keysOf(await ownReads(A)).includes(`preread:${preread.id}`),
      keysOf(await ownReads(A)).join())

    // Put the preread back, ranked, for the freeze test.
    await logRead(A, preread, 'read', { rating: 5, liked: true })
    await setReads(A, [preread, R[0], R[1]])
    check('the preread is ranked again, in slot 1, for the freeze test',
      keysOf(await ownReads(A))[0] === `preread:${preread.id}`)

    // ───────────────────────────────────────────────────────────────────────
    section('8. PRIVACY — the same gate as the log, not a second copy of it')

    // P is private. Give them a Top Four to hide.
    await logShow(P, S[0], 'seen', { rating: 5 })
    await logShow(P, S[1], 'seen')
    const { error: pSetErr } = await setShows(P, [S[0], S[1]])
    check('a private person can set their own Top Four', !pSetErr, pSetErr?.message)

    await logRead(P, R[0], 'read')
    await setReads(P, [R[0]])

    check('P sees their own show Top Four', (await showsAsSeenBy(P, P.id)).length === 2)
    check('B — a stranger — sees NOTHING of P\'s show Top Four',
      (await showsAsSeenBy(B, P.id)).length === 0)
    check('B sees nothing of P\'s article Top Four either',
      (await readsAsSeenBy(B, P.id)).length === 0)
    check('a SIGNED-OUT visitor sees nothing of P\'s show Top Four',
      (await showsAsSeenBy(null, P.id)).length === 0)
    check('F — an APPROVED follower — sees P\'s show Top Four',
      (await showsAsSeenBy(F, P.id)).length === 2)
    check('...and P\'s article Top Four',
      (await readsAsSeenBy(F, P.id)).length === 1)

    // A public profile is public, to everyone, exactly as its log is.
    check('B sees A\'s public show Top Four', (await showsAsSeenBy(B, A.id)).length > 0)
    check('a signed-out visitor sees A\'s public show Top Four',
      (await showsAsSeenBy(null, A.id)).length > 0)

    // A block hides it in both directions, through the same function.
    const { error: blockErr } = await P.client
      .from('blocks')
      .insert({ blocker_id: P.id, blocked_id: B.id })
    if (blockErr) throw new Error(`block: ${blockErr.message}`)
    check('after P blocks B, B sees nothing of P\'s Top Four',
      (await showsAsSeenBy(B, P.id)).length === 0)
    await P.client.from('blocks').delete().eq('blocker_id', P.id).eq('blocked_id', B.id)

    // The RLS read is first-person, as on the log tables.
    const { data: crossRead } = await B.client
      .from('top_four_exhibitions')
      .select('exhibition_id')
      .eq('user_id', A.id)
    check('B cannot read A\'s rows straight from the table — RLS is first-person',
      (crossRead ?? []).length === 0, JSON.stringify(crossRead))

    // ───────────────────────────────────────────────────────────────────────
    // THE CHECK THE SQL EDITOR COULD NEVER MAKE.
    section('9. There are NO direct write grants — the list is the unit of write')

    const { error: directInsert } = await A.client
      .from('top_four_exhibitions')
      .insert({ user_id: A.id, exhibition_id: S[0], position: 2 })
    check('a signed-in person cannot INSERT a Top Four row directly',
      refused(directInsert), directInsert?.message ?? 'the INSERT was ACCEPTED')

    const { error: directUpdate } = await A.client
      .from('top_four_exhibitions')
      .update({ position: 4 })
      .eq('user_id', A.id)
      .eq('exhibition_id', S[0])
    check('...nor UPDATE one, which is what a naive reorder would do',
      refused(directUpdate), directUpdate?.message ?? 'the UPDATE was ACCEPTED')

    const { error: directDelete } = await A.client
      .from('top_four_exhibitions')
      .delete()
      .eq('user_id', A.id)
      .eq('exhibition_id', S[0])
    check('...nor DELETE one', refused(directDelete), directDelete?.message ?? 'the DELETE was ACCEPTED')

    check('and the list survived all three attempts',
      (await ownShows(A)).length > 0)

    const { error: contentInsert } = await A.client
      .from('top_four_content')
      .insert({ user_id: A.id, content_type: 'reading', content_id: R[0].id, position: 4 })
    check('the same holds for the article table', !!contentInsert,
      contentInsert ? undefined : 'the INSERT was ACCEPTED')

    // Nobody can set somebody else's list, because the function takes no
    // user_id at all — it reads auth.uid().
    const beforeCross = orderOf(await ownShows(A))
    await setShows(B, [])
    check('B calling the function cannot touch A\'s list — there is no user_id to pass',
      orderOf(await ownShows(A)).join() === beforeCross.join())

    // Signed out, the grant is what refuses it, before auth.uid() is consulted.
    const anon = createClient(URL, ANON, { auth: { persistSession: false } })
    const { error: anonErr } = await anon.rpc('set_top_four_exhibitions', { p_ids: [S[0]] })
    check('a signed-out caller cannot execute the set function at all',
      refused(anonErr), anonErr?.message ?? 'ACCEPTED')

    // ───────────────────────────────────────────────────────────────────────
    // THE PER-ITEM PATH. B is used from here on precisely because they have
    // nothing yet: every check below starts from an empty list, and A's
    // carefully-built state is needed intact for the freeze test.
    section('10. ADDING AND REMOVING ONE SHOW AT A TIME')

    await logShow(B, S[0], 'seen')
    await logShow(B, S[1], 'seen')

    const { error: add1Err } = await addShow(B, S[0])
    check('adding one show to an empty Top Four is accepted', !add1Err, add1Err?.message)
    check('...it lands in slot 1', orderOf(await ownShows(B)).join() === S[0])

    const { error: add2Err } = await addShow(B, S[1])
    check('adding a second is accepted', !add2Err, add2Err?.message)
    check('...it goes on the END, leaving the first where it was',
      orderOf(await ownShows(B)).join() === [S[0], S[1]].join(),
      orderOf(await ownShows(B)).join())
    check('...and the slots are 1 and 2',
      (await ownShows(B)).map((r) => r.position).join() === '1,2')

    // A double-clicked button, in effect.
    const { error: againErr } = await addShow(B, S[0])
    check('adding something already in the list is a silent no-op, not an error',
      !againErr, againErr?.message)
    check('...and the list is unchanged',
      orderOf(await ownShows(B)).join() === [S[0], S[1]].join(),
      orderOf(await ownShows(B)).join())

    // ELIGIBILITY IS STILL ENFORCED ON THIS PATH — the wrapper delegates to
    // the same function, so the same trigger and the same foreign key apply.
    // Tested while there is still ROOM, so a refusal cannot be the size rule
    // wearing the wrong hat.
    const { error: addUnloggedErr } = await addShow(B, S[5])
    check('adding a show with no log at all is refused, even one at a time',
      refused(addUnloggedErr), addUnloggedErr?.message ?? 'ACCEPTED')

    await logShow(B, S[4], 'want_to_see')
    const { error: addWantErr } = await addShow(B, S[4])
    check('adding a want_to_see show is refused', refused(addWantErr), addWantErr?.message ?? 'ACCEPTED')
    check('...naming the status rule',
      (addWantErr?.message ?? '').includes('top_four_not_seen'), addWantErr?.message)
    check('...and neither refusal disturbed the list',
      orderOf(await ownShows(B)).join() === [S[0], S[1]].join(),
      orderOf(await ownShows(B)).join())

    // Fill it.
    await logShow(B, S[2], 'seen')
    await logShow(B, S[3], 'seen')
    await addShow(B, S[2])
    const { error: add4Err } = await addShow(B, S[3])
    check('the fourth is accepted', !add4Err, add4Err?.message)
    check('...and the list is full, in the order they were added',
      orderOf(await ownShows(B)).join() === [S[0], S[1], S[2], S[3]].join(),
      orderOf(await ownShows(B)).join())

    // THE FIFTH. Refused, and nothing is bumped to make room.
    await logShow(B, S[4], 'seen')
    const { error: fifthErr } = await addShow(B, S[4])
    check('adding a FIFTH is refused', refused(fifthErr), fifthErr?.message ?? 'ACCEPTED')
    check('...naming the full rule, not a constraint',
      (fifthErr?.message ?? '').includes('top_four_full'), fifthErr?.message)
    check('...and the four already there are untouched — nothing was bumped',
      orderOf(await ownShows(B)).join() === [S[0], S[1], S[2], S[3]].join(),
      orderOf(await ownShows(B)).join())
    check('...with no partial state: still exactly four rows, slots 1-4',
      (await ownShows(B)).map((r) => r.position).join() === '1,2,3,4',
      (await ownShows(B)).map((r) => r.position).join())

    // REMOVING ONE, independently of the rest.
    const { error: dropErr } = await dropShow(B, S[1])
    check('removing one show is accepted', !dropErr, dropErr?.message)
    check('...the others keep their order',
      orderOf(await ownShows(B)).join() === [S[0], S[2], S[3]].join(),
      orderOf(await ownShows(B)).join())
    check('...and the gap is CLOSED — slots 1, 2, 3 with no hole',
      (await ownShows(B)).map((r) => r.position).join() === '1,2,3',
      (await ownShows(B)).map((r) => r.position).join())

    const { error: dropAgainErr } = await dropShow(B, S[1])
    check('removing something that is not in the list is a silent no-op',
      !dropAgainErr, dropAgainErr?.message)
    check('...and changes nothing', (await ownShows(B)).length === 3)

    // And the freed slot is usable again.
    const { error: refillErr } = await addShow(B, S[4])
    check('once there is room, the fifth goes in', !refillErr, refillErr?.message)
    check('...at the end, in slot 4',
      orderOf(await ownShows(B)).join() === [S[0], S[2], S[3], S[4]].join(),
      orderOf(await ownShows(B)).join())

    // ───────────────────────────────────────────────────────────────────────
    section('11. ADDING AND REMOVING ONE ARTICLE AT A TIME')

    await logRead(B, R[0], 'read')
    await logRead(B, R[1], 'read')

    const { error: addRead1Err } = await addRead(B, R[0])
    check('adding one article to an empty Top Four is accepted',
      !addRead1Err, addRead1Err?.message)
    check('...it lands in slot 1',
      keysOf(await ownReads(B)).join() === `reading:${R[0].id}`)

    await addRead(B, R[1])
    const { error: addReadAgainErr } = await addRead(B, R[0])
    check('adding an article already in the list is a silent no-op',
      !addReadAgainErr, addReadAgainErr?.message)
    check('...and the list is unchanged',
      keysOf(await ownReads(B)).join() ===
        [`reading:${R[0].id}`, `reading:${R[1].id}`].join(),
      keysOf(await ownReads(B)).join())

    // Eligibility, while there is still room. B has never logged the preread.
    const { error: addUnreadErr } = await addRead(B, preread)
    check('adding an article with no log at all is refused',
      refused(addUnreadErr), addUnreadErr?.message ?? 'ACCEPTED')

    await logRead(B, preread, 'reading_list')
    const { error: addListErr } = await addRead(B, preread)
    check('adding a reading_list article is refused', refused(addListErr), addListErr?.message ?? 'ACCEPTED')
    check('...naming the status rule',
      (addListErr?.message ?? '').includes('top_four_not_read'), addListErr?.message)

    // Fill it, then try a fifth.
    await logRead(B, R[2], 'read')
    await logRead(B, R[3], 'read')
    await addRead(B, R[2])
    await addRead(B, R[3])
    check('four articles are in', (await ownReads(B)).length === 4)

    await logRead(B, preread, 'read')
    const { error: fifthReadErr } = await addRead(B, preread)
    check('adding a FIFTH article is refused', refused(fifthReadErr), fifthReadErr?.message ?? 'ACCEPTED')
    check('...naming the full rule',
      (fifthReadErr?.message ?? '').includes('top_four_full'), fifthReadErr?.message)
    check('...and the four already there are untouched',
      keysOf(await ownReads(B)).join() ===
        [`reading:${R[0].id}`, `reading:${R[1].id}`, `reading:${R[2].id}`, `reading:${R[3].id}`].join(),
      keysOf(await ownReads(B)).join())

    const { error: dropReadErr } = await dropRead(B, R[1])
    check('removing one article is accepted', !dropReadErr, dropReadErr?.message)
    check('...the others keep their order and the gap closes',
      keysOf(await ownReads(B)).join() ===
        [`reading:${R[0].id}`, `reading:${R[2].id}`, `reading:${R[3].id}`].join() &&
        (await ownReads(B)).map((r) => r.position).join() === '1,2,3',
      keysOf(await ownReads(B)).join())

    const { error: dropReadAgainErr } = await dropRead(B, R[1])
    check('removing an article that is not in the list is a silent no-op',
      !dropReadAgainErr, dropReadAgainErr?.message)
    check('...and changes nothing', (await ownReads(B)).length === 3)

    // A PREREAD added one at a time — the other content type, which shares the
    // function but not the table it resolves against.
    const { error: addPrereadErr } = await addRead(B, preread)
    check('a preread can be added one at a time', !addPrereadErr, addPrereadErr?.message)
    check('...and sits alongside the readings in slot 4',
      keysOf(await ownReads(B))[3] === `preread:${preread.id}`,
      keysOf(await ownReads(B)).join())

    // The per-item path is still the caller's own list only.
    const beforeAWrites = orderOf(await ownShows(A))
    await addShow(B, S[0])
    check('B adding to their own list cannot touch A\'s',
      orderOf(await ownShows(A)).join() === beforeAWrites.join())

    const { error: anonAddErr } = await anon.rpc('add_to_top_four_exhibition', {
      p_exhibition_id: S[0],
    })
    check('a signed-out caller cannot execute the per-item add either',
      refused(anonAddErr), anonAddErr?.message ?? 'ACCEPTED')

    // B is left with a full-ish pair of lists; nothing below reads them.

    // ───────────────────────────────────────────────────────────────────────
    // NOT TESTED HERE, DELIBERATELY: the `e.status = 'published'` filter in
    // both read functions.
    //
    // Proving it would mean unpublishing a REAL exhibition and publishing it
    // again, because an unpublished show cannot be logged in the first place
    // (v62's trigger refuses it) and so cannot be ranked. For the seconds
    // between the two writes that show would vanish from the live site, and if
    // this script died in between it would stay gone. That is not a trade
    // worth making for a filter that is copied verbatim from
    // profile_exhibition_logs() and profile_reading_logs(), where it is
    // already exercised.
    //
    // If it ever needs proving directly, do it against a throwaway exhibition
    // row on a non-production database rather than toggling a real one.

    // ───────────────────────────────────────────────────────────────────────
    // THE CRITICAL SECTION FOR THIS PHASE.
    section('12. A FROZEN PREREAD KEEPS ITS SLOT AND ITS ORIGINAL CONTENT')

    const beforeFreeze = await readsAsSeenBy(B, A.id)
    const slotBefore = beforeFreeze.find((e) => e.content_id === preread.id)
    check('setup: the preread is visible in A\'s article Top Four', !!slotBefore)
    check('...in slot 1', slotBefore?.position === 1, `${slotBefore?.position}`)

    // The sequence lib/agent2.ts's freezeAndReplace() runs, using its own
    // helpers: insert the replacement first, then freeze the logged row.
    const fresh = {
      article_title: `${MARK} (replacement)`,
      publication: 'Test Publication',
      article_url: `https://example.invalid/top-four-test/${Date.now()}-replacement`,
      thumbnail_url: null,
      summary: null,
    }

    const { data: inserted, error: insertErr } = await admin
      .from('prereads')
      .insert(replacementInsert(host.id, fresh, null))
      .select('id, article_title')
      .single()
    if (insertErr) throw new Error(`replacement insert: ${insertErr.message}`)
    madePrereads.push(inserted.id)

    const { error: freezeErr } = await admin
      .from('prereads')
      .update(freezeUpdate(inserted.id))
      .eq('id', prereadRow.id)
    check('the ranked preread is frozen without error', !freezeErr, freezeErr?.message)

    const afterFreeze = await readsAsSeenBy(B, A.id)
    const slotAfter = afterFreeze.find((e) => e.content_id === preread.id)

    check('the frozen preread STILL HOLDS ITS SLOT', !!slotAfter)
    check('...still slot 1', slotAfter?.position === 1, `${slotAfter?.position}`)
    check('...rendering the ORIGINAL article the person picked, not the replacement',
      slotAfter?.title === prereadRow.article_title,
      `got "${slotAfter?.title}", wanted "${prereadRow.article_title}"`)
    check('...with the original url, byte for byte',
      slotAfter?.article_url === prereadRow.article_url, `${slotAfter?.article_url}`)
    check('...flagged superseded, so the page can say it has been replaced',
      slotAfter?.superseded === true, `${slotAfter?.superseded}`)
    check('...and the REPLACEMENT article never appears in the Top Four',
      !afterFreeze.some((e) => e.content_id === inserted.id),
      keysOf(afterFreeze).join())
    check('...and the rating rides along from the log',
      slotAfter?.rating === 5, `${slotAfter?.rating}`)

    // The row is still editable: the whole list can be re-saved with the
    // frozen preread in it. A re-check of row_status on write would freeze the
    // list shut, which is the trap v63 documents on the log itself.
    const { error: reSaveErr } = await setReads(A, [R[0], preread])
    check('the list can still be re-saved with the frozen preread in it',
      !reSaveErr, reSaveErr?.message)
    check('...and it moved to slot 2 as asked',
      keysOf(await ownReads(A)).join() === `reading:${R[0].id},preread:${preread.id}`,
      keysOf(await ownReads(A)).join())

    // ───────────────────────────────────────────────────────────────────────
    section('13. The shape the profile page draws')

    const shownShows = await showsAsSeenBy(B, A.id)
    check('slots come back in position order',
      shownShows.map((r) => r.position).join() ===
        [...shownShows.map((r) => r.position)].sort((a, b) => a - b).join(),
      shownShows.map((r) => r.position).join())
    check('each slot carries what the page needs to draw it',
      shownShows.every((r) => typeof r.show_title === 'string' && 'venue_name' in r && 'image_url' in r),
      JSON.stringify(shownShows[0]))
    check('fewer than four picked returns fewer than four rows — empty slots are the UI\'s job',
      (await readsAsSeenBy(B, A.id)).length === 2)

  } finally {
    section('Cleaning up')

    if (madePrereads.length > 0) {
      // superseded_by is ON DELETE SET NULL, so deleting the replacement first
      // cannot take the frozen row with it.
      const { error } = await admin.from('prereads').delete().in('id', madePrereads)
      if (error) console.log(`  ! could not delete test prereads: ${error.message}`)
      else console.log(`  removed ${madePrereads.length} test preread rows`)
    }

    for (const p of people) {
      // Deleting the account cascades to profiles, follows, blocks, the logs
      // and — new in this phase — the Top Four rows hanging off those logs.
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
