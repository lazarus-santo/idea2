/**
 * End-to-end check of migration_v48: unfollow, remove-follower, mute, block.
 *
 *   node --env-file=.env.local scripts/test-relationships.mjs
 *
 * RUN IT AFTER PASTING supabase/migration_v48.sql INTO THE SQL EDITOR. It
 * talks to the live database over the REST API with real signed-in sessions,
 * which is the only way to exercise any of this: the SQL editor runs as
 * postgres and bypasses every policy the migration is made of.
 *
 * It creates four throwaway accounts of its own and deletes them at the end,
 * in a finally block, so a failure halfway through still cleans up. It never
 * reads, writes or deletes anything belonging to a real account — every row it
 * touches hangs off a uuid it created this run.
 *
 * The four accounts, because the roles matter to what is being proved:
 *   A  the one doing the blocking and muting          (public)
 *   B  the other party                                 (public)
 *   P  a private account, for the re-follow-after-removal rule
 *   T  a third party, whose follower list is where mutual invisibility has to
 *      hold even though neither A nor B is looking at the other's profile
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
  const email = `rel-test-${tag}-${Date.now()}@example.invalid`
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createErr) throw new Error(`createUser(${tag}): ${createErr.message}`)

  const id = created.user.id
  const username = `reltest_${tag}_${id.slice(0, 6)}`

  // Onboarding, done with the service key: the profile row exists already
  // (migration_v40's signup trigger) but has no username until someone claims
  // one, and every function under test skips rows without one.
  const { error: profileErr } = await admin
    .from('profiles')
    .update({ username, display_name: `Rel Test ${tag.toUpperCase()}`, privacy })
    .eq('id', id)
  if (profileErr) throw new Error(`profile(${tag}): ${profileErr.message}`)

  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`signIn(${tag}): ${signInErr.message}`)

  return { tag, id, username, client }
}

/** Did this profile come back from person search, for this caller? */
async function findsInSearch(caller, target) {
  const { data, error } = await caller.client
    .rpc('search_profile_cards', { q: target.username, max_rows: 50 })
  if (error) throw new Error(`search as ${caller.tag}: ${error.message}`)
  return (data ?? []).some(r => r.id === target.id)
}

/** Does /u/<handle> exist for this caller? The page 404s when it does not. */
async function canLoadProfilePage(caller, target) {
  const { data, error } = await caller.client
    .rpc('profile_card', { handle: target.username })
  if (error) throw new Error(`profile_card as ${caller.tag}: ${error.message}`)
  return (data ?? []).length > 0
}

/** Is there a follow row, and at what status? Read with the service key so the
 *  answer is the truth rather than what a policy lets somebody see. */
async function followStatus(follower, followed) {
  const { data } = await admin
    .from('follows')
    .select('status')
    .eq('follower_id', follower.id)
    .eq('followed_id', followed.id)
    .maybeSingle()
  return data?.status ?? null
}

async function feedActorIds(caller) {
  const { data, error } = await caller.client.rpc('feed_events', {})
  if (error) throw new Error(`feed as ${caller.tag}: ${error.message}`)
  return (data ?? []).map(e => e.actor_id)
}

async function main() {
  const accounts = []

  try {
    console.log('Creating four throwaway accounts…')
    const A = await makeAccount('a', 'public')
    const B = await makeAccount('b', 'public')
    const P = await makeAccount('p', 'private')
    const T = await makeAccount('t', 'public')
    accounts.push(A, B, P, T)
    console.log(`  A=${A.username}  B=${B.username}  P=${P.username}  T=${T.username}`)

    // ---------------------------------------------------------------- 1
    section('1. UNFOLLOW — from the Following list, removes the relationship')
    await A.client.from('follows').insert({ follower_id: A.id, followed_id: B.id })
    check('A follows B (public → approved straight away)',
      await followStatus(A, B) === 'approved')

    // The exact statement the Following list's menu item runs.
    const unfollow = await A.client.from('follows').delete()
      .eq('follower_id', A.id).eq('followed_id', B.id)
    check('unfollow succeeds', !unfollow.error, unfollow.error?.message)
    check('the follow row is gone', await followStatus(A, B) === null)

    // ---------------------------------------------------------------- 2
    section('2. REMOVE FOLLOWER — soft, and they can come back')
    await B.client.from('follows').insert({ follower_id: B.id, followed_id: A.id })
    check('B follows A', await followStatus(B, A) === 'approved')

    // The statement the Followers list's menu item runs: A deletes the edge
    // pointing AT A, which is the other end from an unfollow.
    const removed = await A.client.from('follows').delete()
      .eq('follower_id', B.id).eq('followed_id', A.id)
    check('A removes B as a follower', !removed.error, removed.error?.message)
    check('the follow row is gone', await followStatus(B, A) === null)
    check('removing did NOT create a block',
      (await admin.from('blocks').select('*').eq('blocker_id', A.id).eq('blocked_id', B.id)).data?.length === 0)
    check('B can still see A in search', await findsInSearch(B, A))

    // Public account: straight back to approved, no request needed.
    await B.client.from('follows').insert({ follower_id: B.id, followed_id: A.id })
    check('B can follow A again immediately (A is public → approved)',
      await followStatus(B, A) === 'approved')

    // Private account: the same removal, but coming back is a fresh request.
    await B.client.from('follows').insert({ follower_id: B.id, followed_id: P.id })
    await admin.from('follows').update({ status: 'approved' })
      .eq('follower_id', B.id).eq('followed_id', P.id)
    check('B is an approved follower of private P', await followStatus(B, P) === 'approved')

    await P.client.from('follows').delete().eq('follower_id', B.id).eq('followed_id', P.id)
    check('P removes B as a follower', await followStatus(B, P) === null)

    await B.client.from('follows').insert({ follower_id: B.id, followed_id: P.id })
    check('B can ask again, and it lands as a fresh request (P is private → pending)',
      await followStatus(B, P) === 'pending')

    // Tidy up so the block tests below start from a known graph.
    await admin.from('follows').delete().eq('follower_id', B.id).eq('followed_id', P.id)

    // ---------------------------------------------------------------- 3
    section('3. MUTE — hides their events from your feed, and nothing else')
    // A follows B in both directions of interest: A must be following B for
    // B's events to be in A's feed at all.
    await A.client.from('follows').insert({ follower_id: A.id, followed_id: B.id })
    await A.client.from('follows').insert({ follower_id: A.id, followed_id: T.id })

    // Events are written with the service key because nothing may write them
    // from a browser — migration_v47 grants no INSERT to authenticated.
    const { error: evErr } = await admin.from('events').insert([
      { actor_id: B.id, type: 'test.relationships', payload: { by: 'b' } },
      { actor_id: T.id, type: 'test.relationships', payload: { by: 't' } },
    ])
    if (evErr) throw new Error(`seed events: ${evErr.message}`)

    let feed = await feedActorIds(A)
    check("A's feed carries B's event before the mute", feed.includes(B.id))
    check("A's feed carries T's event", feed.includes(T.id))

    const muteRes = await A.client.from('mutes').insert({ muter_id: A.id, muted_id: B.id })
    check('A mutes B', !muteRes.error, muteRes.error?.message)

    feed = await feedActorIds(A)
    check("B's event is gone from A's feed", !feed.includes(B.id))
    check("T's event is untouched", feed.includes(T.id))

    check('the follow A→B still stands', await followStatus(A, B) === 'approved')
    check('A can still load B\'s profile', await canLoadProfilePage(A, B))
    check('A can still find B in search', await findsInSearch(A, B))
    check('B can still load A\'s profile', await canLoadProfilePage(B, A))
    check('B can still find A in search', await findsInSearch(B, A))
    check('B still follows A', await followStatus(B, A) === 'approved')

    // The half that matters most: B has no way to observe any of it.
    const bSeesMutes = await B.client.from('mutes').select('*')
    check('B sees no mute rows at all (not even the one naming B)',
      !bSeesMutes.error && (bSeesMutes.data ?? []).length === 0,
      bSeesMutes.error?.message)

    // Reversible, and the history comes back because nothing was deleted.
    await A.client.from('mutes').delete().eq('muter_id', A.id).eq('muted_id', B.id)
    feed = await feedActorIds(A)
    check("unmuting brings B's event back", feed.includes(B.id))

    // ---------------------------------------------------------------- 4
    section('4. BLOCK — one action, both directions')
    // Set the stage: A→B, B→A, and both of them following T so there is a
    // third party's follower list to check later.
    check('A follows B', await followStatus(A, B) === 'approved')
    check('B follows A', await followStatus(B, A) === 'approved')
    await B.client.from('follows').insert({ follower_id: B.id, followed_id: T.id })

    const tFollowersBefore = await T.client.rpc('profile_followers', { profile_id: T.id })
    check('A and B both appear in T\'s follower list beforehand',
      (tFollowersBefore.data ?? []).some(r => r.id === A.id) &&
      (tFollowersBefore.data ?? []).some(r => r.id === B.id))

    const blockRes = await A.client.from('blocks').insert({ blocker_id: A.id, blocked_id: B.id })
    check('A blocks B', !blockRes.error, blockRes.error?.message)

    check('A→B follow severed', await followStatus(A, B) === null)
    check('B→A follow severed', await followStatus(B, A) === null)

    section('   …and the two accounts are invisible to each other')
    check('B cannot find A in search', !(await findsInSearch(B, A)))
    check('B cannot load A\'s profile page', !(await canLoadProfilePage(B, A)))
    check('A cannot find B in search', !(await findsInSearch(A, B)))
    check('A cannot load B\'s profile page', !(await canLoadProfilePage(A, B)))

    // The profile page is not the only way to reach a profile row — the table
    // is readable over REST directly, so the policy has to refuse too.
    const bReadsA = await B.client.from('profiles').select('id, bio').eq('id', A.id)
    check('B cannot read A\'s row from public.profiles either',
      !bReadsA.error && (bReadsA.data ?? []).length === 0, bReadsA.error?.message)

    // Mutual invisibility has to survive a third party's list.
    const tFollowersAsB = await B.client.rpc('profile_followers', { profile_id: T.id })
    check('B does not find A inside T\'s follower list',
      !(tFollowersAsB.data ?? []).some(r => r.id === A.id))
    check('B still sees T\'s other followers (B itself)',
      (tFollowersAsB.data ?? []).some(r => r.id === B.id))

    section('   …and the block refuses a new follow, without announcing itself')
    const blockedFollow = await B.client.from('follows')
      .insert({ follower_id: B.id, followed_id: A.id })
    check('B\'s follow attempt raises no error (silence, not a rejection notice)',
      !blockedFollow.error, blockedFollow.error?.message)
    check('…and inserted nothing', await followStatus(B, A) === null)

    section('   …and nobody but A can see the block')
    const bSeesBlocks = await B.client.from('blocks').select('*')
    check('B sees no block rows (not even the one naming B)',
      !bSeesBlocks.error && (bSeesBlocks.data ?? []).length === 0, bSeesBlocks.error?.message)
    const tSeesBlocks = await T.client.from('blocks').select('*')
    check('an uninvolved account sees no block rows',
      !tSeesBlocks.error && (tSeesBlocks.data ?? []).length === 0, tSeesBlocks.error?.message)
    const bBlockedList = await B.client.rpc('blocked_profiles')
    check('blocked_profiles() answers only about its caller (B\'s is empty)',
      !bBlockedList.error && (bBlockedList.data ?? []).length === 0, bBlockedList.error?.message)
    const aBlockedList = await A.client.rpc('blocked_profiles')
    check('A sees B on A\'s own blocked list, with a name attached',
      (aBlockedList.data ?? []).some(r => r.id === B.id && r.username === B.username))

    // THE THIRD-PARTY QUESTION, asked four ways.
    //
    // block_between(a, b) answers about any two accounts and is_blocked(other)
    // tells its caller whether they have been blocked — neither is anybody's
    // to ask over HTTP. v48 tried to stop that with REVOKE and the revoke did
    // not hold: both answered with the anon key in production. v49 moves them
    // into the `private` schema, which PostgREST does not route to, so the
    // expected result here is "no such function" rather than "not permitted".
    //
    // Probed as an uninvolved signed-in account AND as a signed-out caller,
    // because the anon key ships in every browser and is the easier one to
    // forget.
    const anon = createClient(URL, ANON, { auth: { persistSession: false } })

    for (const [who, client] of [['a signed-in stranger', T.client], ['a signed-out caller', anon]]) {
      const pair = await client.rpc('block_between', { a: A.id, b: B.id })
      check(`${who} cannot ask whether two other accounts have blocked each other`,
        !!pair.error, pair.error ? pair.error.code : `answered ${JSON.stringify(pair.data)}`)

      const self = await client.rpc('is_blocked', { other: A.id })
      check(`${who} cannot ask whether they have been blocked`,
        !!self.error, self.error ? self.error.code : `answered ${JSON.stringify(self.data)}`)
    }

    // ---------------------------------------------------------------- 5
    section('5. UNBLOCK — visibility back, the follows NOT back')
    const unblock = await A.client.from('blocks').delete()
      .eq('blocker_id', A.id).eq('blocked_id', B.id)
    check('A unblocks B', !unblock.error, unblock.error?.message)

    check('B can find A in search again', await findsInSearch(B, A))
    check('B can load A\'s profile again', await canLoadProfilePage(B, A))
    check('A can find B again', await findsInSearch(A, B))
    check('A can load B\'s profile again', await canLoadProfilePage(A, B))

    check('the A→B follow did NOT come back', await followStatus(A, B) === null)
    check('the B→A follow did NOT come back', await followStatus(B, A) === null)

    await B.client.from('follows').insert({ follower_id: B.id, followed_id: A.id })
    check('following again works, as a fresh follow', await followStatus(B, A) === 'approved')

    // ---------------------------------------------------------------- 6
    section('6. PRIVACY IS STILL THE FIRST GATE — block did not replace it')
    check('a private account is still findable in search', await findsInSearch(B, P))
    check('…and its card still answers, so it can be asked', await canLoadProfilePage(B, P))
    const pRow = await B.client.from('profiles').select('id, bio').eq('id', P.id)
    check('…but its contents are still withheld',
      !pRow.error && (pRow.data ?? []).length === 0, pRow.error?.message)

    // And blocking a private account overrides that discoverability, which is
    // the scoped exception this build is allowed to make.
    await P.client.from('blocks').insert({ blocker_id: P.id, blocked_id: B.id })
    check('a private account that blocks you is not findable either',
      !(await findsInSearch(B, P)))
    check('…and its card stops answering', !(await canLoadProfilePage(B, P)))
    await P.client.from('blocks').delete().eq('blocker_id', P.id).eq('blocked_id', B.id)
    check('unblocking restores the private account to search', await findsInSearch(B, P))

    // ---------------------------------------------------------------- 7
    section('7. SELF-ACTIONS ARE REFUSED BY THE DATABASE, not just the UI')
    // The expected code is asserted, not merely "something went wrong". Before
    // the migration is applied these inserts also fail — with 42P01, no such
    // table — and a bare truthy check would report a pass for a schema that
    // does not exist.
    const refusedWith = (res, ...codes) => !!res.error && codes.includes(res.error.code)

    const selfBlock = await A.client.from('blocks').insert({ blocker_id: A.id, blocked_id: A.id })
    check('blocking yourself is refused by the CHECK constraint',
      refusedWith(selfBlock, '23514'), selfBlock.error?.code ?? 'no error')

    const selfMute = await A.client.from('mutes').insert({ muter_id: A.id, muted_id: A.id })
    check('muting yourself is refused by the CHECK constraint',
      refusedWith(selfMute, '23514'), selfMute.error?.code ?? 'no error')

    const blockAsSomeoneElse = await B.client.from('blocks')
      .insert({ blocker_id: A.id, blocked_id: T.id })
    check('blocking on somebody else\'s behalf is refused by RLS',
      refusedWith(blockAsSomeoneElse, '42501'), blockAsSomeoneElse.error?.code ?? 'no error')

    const muteAsSomeoneElse = await B.client.from('mutes')
      .insert({ muter_id: A.id, muted_id: T.id })
    check('muting on somebody else\'s behalf is refused by RLS',
      refusedWith(muteAsSomeoneElse, '42501'), muteAsSomeoneElse.error?.code ?? 'no error')

    // created_at is not in the INSERT grant, so a client cannot backdate a
    // block or a mute the way v44 stopped it backdating a follow request.
    const backdated = await A.client.from('blocks')
      .insert({ blocker_id: A.id, blocked_id: T.id, created_at: '2000-01-01T00:00:00Z' })
    check('a client cannot set created_at on a block',
      refusedWith(backdated, '42501'), backdated.error?.code ?? 'no error')

    // ---------------------------------------------------------------- 8
    section('8. FOLLOWER AND FOLLOWING LISTS NEED AN ACCOUNT (v51)')
    // Probed with the anon key and NO session, which is the only probe that
    // means anything here: the anon key ships in every browser, so a gate that
    // lives in the UI is not a gate. The numbers stay public; the names do not.
    const outsider = createClient(URL, ANON, { auth: { persistSession: false } })

    const anonFollowers = await outsider.rpc('profile_followers', { profile_id: T.id })
    check('a signed-out caller cannot read a follower list',
      refusedWith(anonFollowers, '42501'),
      anonFollowers.error?.code ?? `returned ${(anonFollowers.data ?? []).length} rows`)

    const anonFollowing = await outsider.rpc('profile_following', { profile_id: T.id })
    check('a signed-out caller cannot read a following list',
      refusedWith(anonFollowing, '42501'),
      anonFollowing.error?.code ?? `returned ${(anonFollowing.data ?? []).length} rows`)

    // The three things v51 deliberately did NOT close. Each is load-bearing:
    // counts are public by decision (v44), and a profile that cannot be found
    // signed-out breaks search and every shared link.
    const anonCounts = await outsider.rpc('follow_counts', { profile_id: T.id })
    check('…but the counts are still public',
      !anonCounts.error && anonCounts.data != null, anonCounts.error?.code)

    const anonCard = await outsider.rpc('profile_card', { handle: T.username })
    check('…and a profile is still findable by handle signed-out',
      !anonCard.error && (anonCard.data ?? []).length === 1, anonCard.error?.code)

    const anonSearch = await outsider.rpc('search_profile_cards', { q: T.username })
    check('…and still findable in search signed-out',
      !anonSearch.error && (anonSearch.data ?? []).some(r => r.id === T.id),
      anonSearch.error?.code)

    // THE WHOLE ANON BOUNDARY, CHECKED AS A TABLE rather than one line per
    // feature. Three migrations in a row shipped `REVOKE ... FROM anon` and
    // left the function callable anyway — the grant also existed through
    // PUBLIC, which that line does not touch (see migration_v52). A per-feature
    // assertion would have caught only the feature being written that day, and
    // did not catch the other four. This asserts the boundary itself.
    const anonShouldBeRefused = [
      ['profile_followers',       { profile_id: T.id }],
      ['profile_following',       { profile_id: T.id }],
      ['pending_follow_requests', {}],
      ['blocked_profiles',        {}],
      ['muted_profiles',          {}],
      ['feed_events',             {}],
    ]
    for (const [fn, args] of anonShouldBeRefused) {
      const r = await outsider.rpc(fn, args)
      check(`anon cannot call ${fn}()`,
        refusedWith(r, '42501'),
        r.error?.code ?? `answered ${JSON.stringify(r.data).slice(0, 30)}`)
    }

    // And the ones that must STAY open, so tightening the boundary later
    // cannot quietly take search or a shared profile link with it.
    const anonMustReach = [
      ['profile_card',         { handle: T.username }],
      ['search_profile_cards', { q: T.username }],
      ['follow_counts',        { profile_id: T.id }],
      ['can_view_profile',     { target: T.id }],
    ]
    for (const [fn, args] of anonMustReach) {
      const r = await outsider.rpc(fn, args)
      check(`anon can still call ${fn}()`, !r.error, r.error?.code)
    }

    // And the older gates still stand in front of the new one for signed-in
    // callers: an account is necessary, not sufficient.
    const signedInFollowers = await B.client.rpc('profile_followers', { profile_id: T.id })
    check('a signed-in caller still gets a public profile\'s list',
      !signedInFollowers.error, signedInFollowers.error?.code)

    const privateList = await B.client.rpc('profile_followers', { profile_id: P.id })
    check('…but still not a private profile\'s list they were not let into',
      !privateList.error && (privateList.data ?? []).length === 0,
      privateList.error?.code ?? `returned ${(privateList.data ?? []).length} rows`)
  } finally {
    console.log('\nCleaning up…')
    for (const a of accounts) {
      // Deleting the auth user cascades to profiles, and profiles cascades to
      // follows, events, blocks and mutes in both directions.
      const { error } = await admin.auth.admin.deleteUser(a.id)
      if (error) console.log(`  ! could not delete ${a.username}: ${error.message}`)
    }
    const leftovers = await admin.from('events').select('id').eq('type', 'test.relationships')
    if ((leftovers.data ?? []).length > 0) {
      await admin.from('events').delete().eq('type', 'test.relationships')
      console.log('  removed leftover test events')
    }
    console.log('  done')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('Failed:\n  - ' + failures.join('\n  - '))
    process.exit(1)
  }
}

main().catch(err => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
