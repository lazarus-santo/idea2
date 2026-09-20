/**
 * End-to-end check of crawls — migration_v66.
 *
 *   node --env-file=.env.local scripts/test-crawls.mjs
 *
 * RUN IT AFTER PASTING supabase/migration_v66.sql INTO THE SQL EDITOR. Like
 * the log and Top Four suites it talks to the live database over the REST API
 * with real signed-in sessions, which is the only way to exercise any of this:
 * the SQL editor runs as postgres and bypasses every policy and grant the
 * migration is made of.
 *
 * THAT MATTERS PARTICULARLY HERE, because half the design is an ABSENCE.
 * crawl_stops has no INSERT, UPDATE or DELETE grant for anybody but
 * service_role, so the only way in is set_crawl_stops(). An absent grant is
 * invisible to postgres, so a check run in the editor would pass whether the
 * design held or not. Section 4 is what proves it, and it can only be proved
 * from a real session.
 *
 * IT ALSO PROVES THE ONE THING NO CONSTRAINT CAN SAY. "Positions run 1..n with
 * no gaps" is a property of a SET of rows: a CHECK sees one row and a UNIQUE
 * sees one pair, so neither expresses it. What makes it true is that
 * set_crawl_stops() numbers the rows itself and nothing else can write them.
 * Section 3 checks it from the outside after every kind of rearrangement,
 * which is where a property of a write path has to be checked.
 *
 * ── WHAT IT WRITES TO PRODUCTION ────────────────────────────────────────────
 *
 * Two throwaway accounts and their crawls, deleted in a finally block so a
 * failure halfway through still cleans up, taking the crawls and stops with
 * them through the cascades. Real exhibitions are READ and never written.
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

/**
 * A real refusal, and not merely a function PostgREST could not find.
 *
 * Every "is refused" check below asks this rather than `!!error`, for the
 * reason scripts/test-top-four.mjs records at length: when a migration had not
 * been applied, calls to its functions came back as "Could not find the
 * function ... in the schema cache" and checks written as `!!error` READ THAT
 * AS THE GUARD WORKING. A missing migration is what this script is for, so a
 * missing migration must never be able to make it greener.
 */
function refused(error) {
  if (!error) return false
  const m = error.message ?? ''
  return !m.includes('Could not find the function') && !m.includes('schema cache')
}

/** A signed-in client for one throwaway account. */
async function makeAccount(tag) {
  const email = `crawl-test-${tag}-${Date.now()}@example.invalid`
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (createErr) throw new Error(`createUser(${tag}): ${createErr.message}`)

  const id = created.user.id
  const username = `crawltest_${tag}_${id.slice(0, 6)}`

  const { error: profileErr } = await admin
    .from('profiles')
    .update({ username, display_name: `Crawl Test ${tag.toUpperCase()}`, privacy: 'public' })
    .eq('id', id)
  if (profileErr) throw new Error(`profile(${tag}): ${profileErr.message}`)

  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`signIn(${tag}): ${signInErr.message}`)

  return { tag, id, username, client }
}

const setStops = (person, crawlId, ids) =>
  person.client.rpc('set_crawl_stops', { p_crawl_id: crawlId, p_exhibition_ids: ids })

/** The stops of a crawl, as the database holds them, read with the service key. */
async function storedStops(crawlId) {
  const { data, error } = await admin
    .from('crawl_stops')
    .select('exhibition_id, position, created_at')
    .eq('crawl_id', crawlId)
    .order('position', { ascending: true })
  if (error) throw new Error(`storedStops: ${error.message}`)
  return data ?? []
}

/** Positions are exactly 1..n, in order, with nothing missing and nothing twice. */
function gapFree(rows) {
  return rows.every((r, i) => r.position === i + 1)
}

async function main() {
  const people = []

  try {
    // ─── Setup ──────────────────────────────────────────────────────────────

    section('Setup')

    const { data: shows, error: showErr } = await admin
      .from('exhibitions')
      .select('id, show_title')
      .eq('status', 'published')
      .limit(5)
    if (showErr) throw new Error(`exhibitions: ${showErr.message}`)
    if (!shows || shows.length < 4) {
      throw new Error(`need at least 4 published exhibitions, found ${shows?.length ?? 0}`)
    }
    const [A, B, C, D] = shows.map((s) => s.id)
    check('four published exhibitions to work with', true)

    const { data: pending } = await admin
      .from('exhibitions')
      .select('id')
      .neq('status', 'published')
      .limit(1)
    const unpublishedId = pending?.[0]?.id ?? null
    console.log(
      unpublishedId
        ? '  · an unpublished exhibition is available for the gate check'
        : '  · no unpublished exhibition in the database — section 5 will skip one check'
    )

    const alice = await makeAccount('alice')
    const bob = await makeAccount('bob')
    people.push(alice, bob)
    check('two throwaway accounts signed in', true)

    // ─── 1. Creating and editing a crawl ────────────────────────────────────

    section('1. The crawl row — owner-only CRUD through RLS')

    const { data: made, error: makeErr } = await alice.client
      .from('crawls')
      .insert({ user_id: alice.id, title: 'Chelsea Saturday', status: 'draft' })
      .select('id, title, status, created_at, updated_at')
      .single()
    check('alice can create a crawl', !makeErr && !!made, makeErr?.message)
    const crawlId = made?.id
    if (!crawlId) throw new Error('no crawl to test with')

    check('it starts as a draft', made.status === 'draft')

    const { error: blankErr } = await alice.client
      .from('crawls')
      .update({ title: '   ' })
      .eq('id', crawlId)
    check('a blank title is refused', !!blankErr, 'the not-blank CHECK did not fire')

    const { error: statusErr } = await alice.client
      .from('crawls')
      .update({ status: 'completed' })
      .eq('id', crawlId)
    check(
      "status 'completed' is refused — that is Phase 2",
      !!statusErr,
      'the status CHECK accepted a Phase 2 value'
    )

    const { error: renameErr } = await alice.client
      .from('crawls')
      .update({ title: 'Chelsea, Saturday afternoon' })
      .eq('id', crawlId)
    check('alice can rename her crawl', !renameErr, renameErr?.message)

    // ─── 2. Privacy ─────────────────────────────────────────────────────────

    section('2. Privacy — the owner, and nobody else')

    const { data: bobSees } = await bob.client
      .from('crawls')
      .select('id')
      .eq('id', crawlId)
    check("bob cannot see alice's crawl", (bobSees ?? []).length === 0)

    const { data: bobList } = await bob.client.from('crawls').select('id')
    check('bob\'s own list does not contain it', !(bobList ?? []).some((c) => c.id === crawlId))

    const { error: bobRenameErr } = await bob.client
      .from('crawls')
      .update({ title: 'Hijacked' })
      .eq('id', crawlId)
    const { data: stillNamed } = await admin
      .from('crawls').select('title').eq('id', crawlId).single()
    check(
      "bob cannot rename alice's crawl",
      stillNamed?.title === 'Chelsea, Saturday afternoon',
      bobRenameErr ? `(errored: ${bobRenameErr.message})` : 'the title changed'
    )

    const { error: bobDeleteErr } = await bob.client.from('crawls').delete().eq('id', crawlId)
    const { data: stillThere } = await admin.from('crawls').select('id').eq('id', crawlId)
    check(
      "bob cannot delete alice's crawl",
      (stillThere ?? []).length === 1,
      bobDeleteErr ? `(errored: ${bobDeleteErr.message})` : 'the crawl is gone'
    )

    const anon = createClient(URL, ANON, { auth: { persistSession: false } })
    const { data: anonSees } = await anon.from('crawls').select('id').eq('id', crawlId)
    check('a signed-out visitor sees nothing', (anonSees ?? []).length === 0)

    const { error: bobStopsErr } = await setStops(bob, crawlId, [A, B])
    check(
      "bob cannot set the stops of alice's crawl",
      refused(bobStopsErr) && (bobStopsErr.message ?? '').includes('crawl_not_found'),
      bobStopsErr?.message ?? 'the write was accepted'
    )

    // ─── 3. Ordering ────────────────────────────────────────────────────────

    section('3. Stops, order, and positions that stay 1..n')

    const { error: setErr } = await setStops(alice, crawlId, [A, B, C])
    check('alice can set three stops', !setErr, setErr?.message)

    let rows = await storedStops(crawlId)
    check('three rows are stored', rows.length === 3, `got ${rows.length}`)
    check(
      'they are in the order they were sent',
      rows[0]?.exhibition_id === A && rows[1]?.exhibition_id === B && rows[2]?.exhibition_id === C
    )
    check('positions are 1, 2, 3', gapFree(rows), JSON.stringify(rows.map((r) => r.position)))

    const addedAt = new Map(rows.map((r) => [r.exhibition_id, r.created_at]))

    // A swap is the case a per-row reorder cannot survive: for an instant two
    // rows would claim slot 1. Sending the whole list means there is no instant.
    const { error: swapErr } = await setStops(alice, crawlId, [B, A, C])
    check('a swap is accepted', !swapErr, swapErr?.message)
    rows = await storedStops(crawlId)
    check('the swap took', rows[0]?.exhibition_id === B && rows[1]?.exhibition_id === A)
    check('positions are still 1, 2, 3', gapFree(rows))
    check(
      'a stop that only moved keeps the date it was added',
      rows.every((r) => r.created_at === addedAt.get(r.exhibition_id)),
      'created_at was restamped by the reorder'
    )

    // A rotation — every row moves at once, which is the worst case for any
    // scheme that renumbers in place.
    const { error: rotErr } = await setStops(alice, crawlId, [C, B, A])
    check('a full rotation is accepted', !rotErr, rotErr?.message)
    rows = await storedStops(crawlId)
    check('positions are still 1, 2, 3', gapFree(rows))

    // Removing from the MIDDLE is what would leave a hole if positions were
    // ever written by a caller.
    const { error: midErr } = await setStops(alice, crawlId, [C, A])
    check('removing the middle stop is accepted', !midErr, midErr?.message)
    rows = await storedStops(crawlId)
    check('the gap closes — positions are 1, 2', gapFree(rows) && rows.length === 2,
      JSON.stringify(rows.map((r) => r.position)))

    const { error: growErr } = await setStops(alice, crawlId, [C, A, B, D])
    check('growing the list is accepted', !growErr, growErr?.message)
    rows = await storedStops(crawlId)
    check('positions are 1, 2, 3, 4', gapFree(rows) && rows.length === 4)
    check(
      'the newly added stop gets its own date',
      !addedAt.has(D) || rows.find((r) => r.exhibition_id === D)?.created_at !== addedAt.get(D)
    )

    const { error: clearErr } = await setStops(alice, crawlId, [])
    check('an empty array clears the crawl', !clearErr, clearErr?.message)
    rows = await storedStops(crawlId)
    check('no stops remain', rows.length === 0, `${rows.length} left`)

    // Back to a real route for the checks below.
    await setStops(alice, crawlId, [A, B, C])

    // ─── 4. crawl_stops takes no row-level writes ───────────────────────────

    section('4. There is no way into crawl_stops but the function')

    const { error: insErr } = await alice.client
      .from('crawl_stops')
      .insert({ crawl_id: crawlId, exhibition_id: D, position: 4 })
    check(
      'a direct INSERT is refused even by the owner',
      !!insErr,
      'crawl_stops accepted a row-level insert'
    )

    const { error: updErr } = await alice.client
      .from('crawl_stops')
      .update({ position: 9 })
      .eq('crawl_id', crawlId)
      .eq('exhibition_id', A)
    const afterUpd = await storedStops(crawlId)
    check(
      'a direct UPDATE cannot renumber a stop',
      gapFree(afterUpd),
      updErr ? `(errored: ${updErr.message}) but positions changed` : 'positions were rewritten'
    )

    const { error: delErr } = await alice.client
      .from('crawl_stops')
      .delete()
      .eq('crawl_id', crawlId)
      .eq('exhibition_id', A)
    const afterDel = await storedStops(crawlId)
    check(
      'a direct DELETE cannot remove a stop',
      afterDel.length === 3,
      delErr ? `(errored: ${delErr.message}) but a row went` : 'a row was deleted'
    )

    const { data: aliceReads } = await alice.client
      .from('crawl_stops')
      .select('exhibition_id, position')
      .eq('crawl_id', crawlId)
    check('the owner can still READ her stops', (aliceReads ?? []).length === 3)

    const { data: bobReads } = await bob.client
      .from('crawl_stops')
      .select('exhibition_id')
      .eq('crawl_id', crawlId)
    check("bob cannot read alice's stops", (bobReads ?? []).length === 0)

    // ─── 5. What the function refuses ───────────────────────────────────────

    section('5. Refusals, by name')

    const { error: dupErr } = await setStops(alice, crawlId, [A, B, A])
    check(
      'the same show twice is refused by name',
      refused(dupErr) && (dupErr.message ?? '').includes('crawl_duplicate_stop'),
      dupErr?.message ?? 'accepted'
    )

    const { error: nullErr } = await setStops(alice, crawlId, [A, null, B])
    check(
      'a null in the middle of the list is refused',
      refused(nullErr),
      nullErr?.message ?? 'accepted'
    )

    const tooMany = Array.from({ length: 26 }, () => A)
    const { error: manyErr } = await setStops(alice, crawlId, tooMany)
    check(
      'twenty-six stops are refused',
      refused(manyErr),
      manyErr?.message ?? 'accepted'
    )

    if (unpublishedId) {
      const { error: pendErr } = await setStops(alice, crawlId, [A, unpublishedId])
      check(
        'an unpublished exhibition cannot be a stop',
        refused(pendErr) && (pendErr.message ?? '').includes('no_such_exhibition'),
        pendErr?.message ?? 'accepted'
      )
    }

    const { error: ghostErr } = await setStops(alice, crawlId, [
      A, '00000000-0000-0000-0000-000000000000',
    ])
    check(
      'an exhibition that does not exist is refused the same way',
      refused(ghostErr) && (ghostErr.message ?? '').includes('no_such_exhibition'),
      ghostErr?.message ?? 'accepted'
    )

    const { error: nobodyErr } = await anon.rpc('set_crawl_stops', {
      p_crawl_id: crawlId,
      p_exhibition_ids: [A],
    })
    check(
      'a signed-out caller is refused',
      refused(nobodyErr),
      nobodyErr?.message ?? 'accepted'
    )

    // A refused write must leave the previous route alone — the delete and the
    // insert are one transaction, so a failure rolls the whole thing back.
    const survived = await storedStops(crawlId)
    check(
      'every refusal above left the saved route untouched',
      survived.length === 3 && gapFree(survived),
      `${survived.length} stops, positions ${JSON.stringify(survived.map((r) => r.position))}`
    )

    // ─── 6. Deleting ────────────────────────────────────────────────────────

    section('6. Deleting a crawl takes its stops with it')

    const { error: dropErr } = await alice.client.from('crawls').delete().eq('id', crawlId)
    check('alice can delete her own crawl', !dropErr, dropErr?.message)

    const orphans = await storedStops(crawlId)
    check('its stops went with it', orphans.length === 0, `${orphans.length} orphaned`)
  } finally {
    section('Cleanup')
    for (const person of people) {
      const { error } = await admin.auth.admin.deleteUser(person.id)
      console.log(
        error ? `  ! ${person.tag}: ${error.message}` : `  · removed ${person.username}`
      )
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) {
    console.log('\nFailures:')
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('\nFATAL:', e.message)
  process.exit(1)
})
