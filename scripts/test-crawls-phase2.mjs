/**
 * End-to-end check of crawls Phase 2 — migration_v67.
 *
 *   node --env-file=.env.local scripts/test-crawls-phase2.mjs
 *
 * RUN IT AFTER PASTING supabase/migration_v67.sql INTO THE SQL EDITOR, and run
 * scripts/test-crawls.mjs alongside it: v67 rewrote set_crawl_stops() as a
 * wrapper, and that suite is what proves the Phase 1 behaviour survived.
 *
 * Real signed-in sessions over the REST API, for the reason every suite here
 * gives: the SQL editor runs as postgres and bypasses every policy and grant
 * this migration is made of.
 *
 * THE CAST
 *   P  public profile — owns the crawls under test
 *   Q  PRIVATE profile — owns a completed crawl too
 *   F  approved follower of Q
 *   S  stranger — follows nobody
 *   B  a public account P blocks partway through
 *   anon — no session at all
 *
 * ── WHAT IT WRITES TO PRODUCTION ────────────────────────────────────────────
 *
 * Five throwaway accounts, their crawls, likes, saves and log entries, all
 * deleted in a finally block through the account cascade. Real exhibitions are
 * READ and never written.
 *
 * ── NOT TESTED, DELIBERATELY ────────────────────────────────────────────────
 *
 * The "skipped" count — a stop whose show was UNPUBLISHED after it was added.
 * Proving it means unpublishing a real exhibition on the live site. The filter
 * is the same published-join the log and Top Four read functions use.
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
const anon = createClient(URL, ANON, { auth: { persistSession: false } })

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
 * A real refusal, not a function PostgREST could not find — see
 * scripts/test-top-four.mjs for why a missing migration must never be able to
 * make this suite greener.
 */
function refused(error) {
  if (!error) return false
  const m = error.message ?? ''
  return !m.includes('Could not find the function') && !m.includes('schema cache')
}

function refusedAs(error, name) {
  return refused(error) && (error.message ?? '').includes(name)
}

async function makeAccount(tag, privacy = 'public') {
  const email = `crawl2-test-${tag}-${Date.now()}@example.invalid`
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (createErr) throw new Error(`createUser(${tag}): ${createErr.message}`)

  const id = created.user.id
  const username = `crawl2_${tag}_${id.slice(0, 6)}`

  const { error: profileErr } = await admin
    .from('profiles')
    .update({ username, display_name: `Crawl2 ${tag.toUpperCase()}`, privacy })
    .eq('id', id)
  if (profileErr) throw new Error(`profile(${tag}): ${profileErr.message}`)

  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`signIn(${tag}): ${signInErr.message}`)

  return { tag, id, username, client }
}

const route = (person, crawlId, stops) =>
  person.client.rpc('set_crawl_route', { p_crawl_id: crawlId, p_stops: stops })

const complete = (person, crawlId) =>
  person.client.rpc('complete_crawl', { p_crawl_id: crawlId })

async function newCrawl(person, title) {
  const { data, error } = await person.client
    .from('crawls')
    .insert({ user_id: person.id, title, status: 'draft' })
    .select('id')
    .single()
  if (error) throw new Error(`newCrawl(${person.tag}): ${error.message}`)
  return data.id
}

async function storedStops(crawlId) {
  const { data, error } = await admin
    .from('crawl_stops')
    .select('exhibition_id, position, arrive_by')
    .eq('crawl_id', crawlId)
    .order('position', { ascending: true })
  if (error) throw new Error(`storedStops: ${error.message}`)
  return data ?? []
}

async function storedCrawl(crawlId) {
  const { data } = await admin
    .from('crawls')
    .select('id, user_id, title, status, completed_at')
    .eq('id', crawlId)
    .maybeSingle()
  return data
}

async function storedLog(userId, exhibitionId) {
  const { data } = await admin
    .from('exhibition_logs')
    .select('status, rating, liked, comment, comment_visibility, updated_at')
    .eq('user_id', userId)
    .eq('exhibition_id', exhibitionId)
    .maybeSingle()
  return data
}

/** Can this client see the crawl row, and how many of its stops? */
async function sees(client, crawlId) {
  const { data: c } = await client.from('crawls').select('id').eq('id', crawlId)
  const { data: s } = await client.from('crawl_stops').select('exhibition_id').eq('crawl_id', crawlId)
  return { crawl: (c ?? []).length === 1, stops: (s ?? []).length }
}

async function likeCount(client, crawlId) {
  const { data, error } = await client.rpc('crawl_like_counts', { p_crawl_ids: [crawlId] })
  if (error) return { error }
  return { row: (data ?? [])[0] ?? null }
}

const like = (person, crawlId) =>
  person.client.from('crawl_likes').upsert(
    { user_id: person.id, crawl_id: crawlId },
    { onConflict: 'user_id,crawl_id', ignoreDuplicates: true }
  )
const unlike = (person, crawlId) =>
  person.client.from('crawl_likes').delete().eq('user_id', person.id).eq('crawl_id', crawlId)
const save = (person, crawlId) =>
  person.client.from('crawl_saves').upsert(
    { user_id: person.id, crawl_id: crawlId },
    { onConflict: 'user_id,crawl_id', ignoreDuplicates: true }
  )

async function main() {
  const people = []

  try {
    // ─── Setup ──────────────────────────────────────────────────────────────

    section('Setup')

    const { data: shows, error: showErr } = await admin
      .from('exhibitions')
      .select('id')
      .eq('status', 'published')
      .limit(6)
    if (showErr) throw new Error(`exhibitions: ${showErr.message}`)
    if (!shows || shows.length < 5) throw new Error('need at least 5 published exhibitions')
    const [A, B, C, D, E] = shows.map((s) => s.id)
    check('five published exhibitions to work with', true)

    const P = await makeAccount('p', 'public')
    const Q = await makeAccount('q', 'private')
    const F = await makeAccount('f', 'public')
    const S = await makeAccount('s', 'public')
    const X = await makeAccount('b', 'public') // blocked later
    people.push(P, Q, F, S, X)

    await F.client.from('follows').insert({ follower_id: F.id, followed_id: Q.id })
    const { error: approveErr } = await Q.client
      .from('follows')
      .update({ status: 'approved' })
      .eq('follower_id', F.id)
      .eq('followed_id', Q.id)
    check('five throwaway accounts; F is an approved follower of private Q', !approveErr, approveErr?.message)

    // ─── 1. Leg modes ───────────────────────────────────────────────────────

    section('1. Walk/drive per leg is saved with the stops')

    const crawlP = await newCrawl(P, 'Chelsea loop')
    const { error: routeErr } = await route(P, crawlP, [
      { exhibition_id: A, arrive_by: 'driving' }, // ignored: nothing leads into stop 1
      { exhibition_id: B, arrive_by: 'walking' },
      { exhibition_id: C, arrive_by: 'driving' },
      { exhibition_id: D },                       // omitted → walking
    ])
    check('P can save a route with modes', !routeErr, routeErr?.message)

    let rows = await storedStops(crawlP)
    check('four stops in order', rows.map((r) => r.exhibition_id).join() === [A, B, C, D].join())
    check('stop 1 has no arrival mode', rows[0]?.arrive_by === null, String(rows[0]?.arrive_by))
    check(
      'later stops keep their modes (walking, driving, walking-by-default)',
      rows[1]?.arrive_by === 'walking' && rows[2]?.arrive_by === 'driving' && rows[3]?.arrive_by === 'walking',
      JSON.stringify(rows.map((r) => r.arrive_by))
    )

    const { error: badModeErr } = await route(P, crawlP, [
      { exhibition_id: A }, { exhibition_id: B, arrive_by: 'flying' },
    ])
    check('an unknown mode is refused, not defaulted', refusedAs(badModeErr, 'crawl_bad_input'), badModeErr?.message ?? 'accepted')

    const { error: badIdErr } = await route(P, crawlP, [{ exhibition_id: 'not-a-uuid' }])
    check('a malformed id is refused by name', refusedAs(badIdErr, 'crawl_bad_input'), badIdErr?.message ?? 'accepted')

    const { error: dupErr } = await route(P, crawlP, [{ exhibition_id: A }, { exhibition_id: A }])
    check('a duplicate stop is still refused', refusedAs(dupErr, 'crawl_duplicate_stop'), dupErr?.message ?? 'accepted')

    rows = await storedStops(crawlP)
    check('those refusals left the route alone', rows.length === 4 && rows[2]?.arrive_by === 'driving')

    const scratch = await newCrawl(P, 'Scratch')
    const { error: wrapErr } = await P.client.rpc('set_crawl_stops', {
      p_crawl_id: scratch, p_exhibition_ids: [A, B, C],
    })
    const wrapped = await storedStops(scratch)
    check(
      'the old set_crawl_stops() still works, every leg walking',
      !wrapErr && wrapped.length === 3 && wrapped[0].arrive_by === null &&
        wrapped.slice(1).every((r) => r.arrive_by === 'walking'),
      wrapErr?.message ?? JSON.stringify(wrapped.map((r) => r.arrive_by))
    )

    const { error: sRouteErr } = await route(S, crawlP, [{ exhibition_id: A }])
    check("a stranger cannot set P's route", refusedAs(sRouteErr, 'crawl_not_found'), sRouteErr?.message ?? 'accepted')

    // ─── 2. 'completed' can only be reached through complete_crawl() ────────

    section("2. 'completed' is set by complete_crawl() and nothing else")

    const { error: directErr } = await P.client.from('crawls').update({ status: 'completed' }).eq('id', crawlP)
    check('a direct status update to completed is refused', refused(directErr), directErr?.message ?? 'accepted')

    const { error: stampErr } = await P.client
      .from('crawls').update({ completed_at: new Date().toISOString() }).eq('id', crawlP)
    check('completed_at cannot be written by a client', refused(stampErr), stampErr?.message ?? 'accepted')

    check('the crawl is still a draft', (await storedCrawl(crawlP))?.status === 'draft')

    const { error: sCompleteErr } = await complete(S, crawlP)
    check("a stranger cannot complete P's crawl", refusedAs(sCompleteErr, 'crawl_not_found'), sCompleteErr?.message ?? 'accepted')

    const { error: anonCompleteErr } = await anon.rpc('complete_crawl', { p_crawl_id: crawlP })
    check('a signed-out caller cannot complete anything', refused(anonCompleteErr), anonCompleteErr?.message ?? 'accepted')

    const empty = await newCrawl(P, 'Empty')
    const { error: emptyErr } = await complete(P, empty)
    check('an empty crawl cannot be completed', refusedAs(emptyErr, 'crawl_empty'), emptyErr?.message ?? 'accepted')

    // ─── 3. The auto-logging rule ───────────────────────────────────────────

    section('3. Completing logs the stops — the three cases')

    // A: no log at all.  B: want_to_see.  C: seen, with a rating, like and a
    // private comment that must survive untouched.  D: no log.
    const { error: seedB } = await P.client.from('exhibition_logs').insert({
      user_id: P.id, exhibition_id: B, status: 'want_to_see',
    })
    const { error: seedC } = await P.client.from('exhibition_logs').insert({
      user_id: P.id, exhibition_id: C, status: 'seen', rating: 4, liked: true,
      comment: 'Went on my own last week', comment_visibility: 'private',
    })
    check('P has a want_to_see on B and a rated, liked, commented seen on C', !seedB && !seedC,
      seedB?.message ?? seedC?.message)

    const beforeC = await storedLog(P.id, C)
    // updated_at resolution is microseconds, but give the clock a moment so an
    // accidental rewrite could not land on the same instant.
    await new Promise((r) => setTimeout(r, 1100))

    const { data: result, error: completeErr } = await complete(P, crawlP)
    check('P can complete her crawl', !completeErr, completeErr?.message)
    check(
      'it reports 2 logged, 1 upgraded, 1 unchanged, 0 skipped',
      result?.logged === 2 && result?.upgraded === 1 && result?.unchanged === 1 &&
        result?.skipped === 0 && result?.already_completed === false,
      JSON.stringify(result)
    )

    const done = await storedCrawl(crawlP)
    check("status is 'completed'", done?.status === 'completed', done?.status)
    check('completed_at is set, and recent', !!done?.completed_at &&
      Math.abs(Date.now() - new Date(done.completed_at).getTime()) < 5 * 60 * 1000, done?.completed_at)

    const logA = await storedLog(P.id, A)
    check('no prior log → a new seen entry with nothing else on it',
      logA?.status === 'seen' && logA.rating === null && logA.liked === false && logA.comment === null,
      JSON.stringify(logA))

    const logB = await storedLog(P.id, B)
    check('want_to_see → upgraded to seen', logB?.status === 'seen', JSON.stringify(logB))

    const logC = await storedLog(P.id, C)
    check('already seen → rating, like, comment and visibility untouched',
      logC?.status === 'seen' && logC.rating === 4 && logC.liked === true &&
        logC.comment === 'Went on my own last week' && logC.comment_visibility === 'private',
      JSON.stringify(logC))
    check('already seen → not even rewritten (updated_at did not move)',
      logC?.updated_at === beforeC?.updated_at, `${beforeC?.updated_at} → ${logC?.updated_at}`)

    const logD = await storedLog(P.id, D)
    check('the fourth stop is logged too', logD?.status === 'seen')

    const { data: again, error: againErr } = await complete(P, crawlP)
    const doneAgain = await storedCrawl(crawlP)
    check('completing twice is a harmless no-op',
      !againErr && again?.already_completed === true && doneAgain?.completed_at === done?.completed_at,
      againErr?.message ?? JSON.stringify(again))

    // ─── 4. A completed route is frozen ─────────────────────────────────────

    section('4. A completed route is a fixed record')

    const { error: frozenErr } = await route(P, crawlP, [{ exhibition_id: A }])
    check('set_crawl_route() refuses a completed crawl', refusedAs(frozenErr, 'crawl_completed'), frozenErr?.message ?? 'accepted')

    const { error: frozenOldErr } = await P.client.rpc('set_crawl_stops', { p_crawl_id: crawlP, p_exhibition_ids: [A] })
    check('so does the old set_crawl_stops()', refusedAs(frozenOldErr, 'crawl_completed'), frozenOldErr?.message ?? 'accepted')

    check('its four stops are all still there', (await storedStops(crawlP)).length === 4)

    const { error: backErr } = await P.client.from('crawls').update({ status: 'draft' }).eq('id', crawlP)
    check('it cannot be moved back to draft', refused(backErr) && (await storedCrawl(crawlP))?.status === 'completed',
      backErr?.message ?? 'accepted')

    const { error: renameErr } = await P.client.from('crawls').update({ title: 'Chelsea loop, done' }).eq('id', crawlP)
    check('it can still be renamed', !renameErr && (await storedCrawl(crawlP))?.title === 'Chelsea loop, done', renameErr?.message)

    // ─── 5. Who can see a completed crawl ───────────────────────────────────

    section('5. Visibility — completed follows can_view_profile(); draft stays owner-only')

    const draftP = await newCrawl(P, 'P draft')
    await route(P, draftP, [{ exhibition_id: A }, { exhibition_id: E }])

    const crawlQ = await newCrawl(Q, 'Q walked')
    await route(Q, crawlQ, [{ exhibition_id: B }, { exhibition_id: E, arrive_by: 'driving' }])
    const { error: qDoneErr } = await complete(Q, crawlQ)
    check('private Q completes a crawl of her own', !qDoneErr, qDoneErr?.message)

    const draftQ = await newCrawl(Q, 'Q draft')
    await route(Q, draftQ, [{ exhibition_id: C }])

    let v = await sees(S.client, crawlP)
    check("public P's completed crawl: a stranger sees it and its 4 stops", v.crawl && v.stops === 4, JSON.stringify(v))
    v = await sees(anon, crawlP)
    check("public P's completed crawl: a signed-out visitor sees it too", v.crawl && v.stops === 4, JSON.stringify(v))
    v = await sees(F.client, crawlP)
    check("public P's completed crawl: F sees it", v.crawl && v.stops === 4, JSON.stringify(v))

    v = await sees(F.client, crawlQ)
    check("private Q's completed crawl: her approved follower sees it", v.crawl && v.stops === 2, JSON.stringify(v))
    v = await sees(S.client, crawlQ)
    check("private Q's completed crawl: a stranger sees nothing", !v.crawl && v.stops === 0, JSON.stringify(v))
    v = await sees(anon, crawlQ)
    check("private Q's completed crawl: a signed-out visitor sees nothing", !v.crawl && v.stops === 0, JSON.stringify(v))

    for (const [who, client] of [['a stranger', S.client], ['a signed-out visitor', anon], ['F', F.client]]) {
      v = await sees(client, draftP)
      check(`P's draft (public profile): ${who} sees nothing`, !v.crawl && v.stops === 0, JSON.stringify(v))
    }
    v = await sees(F.client, draftQ)
    check("Q's draft: even her approved follower sees nothing", !v.crawl && v.stops === 0, JSON.stringify(v))
    v = await sees(Q.client, draftQ)
    check('Q still sees her own draft', v.crawl && v.stops === 1, JSON.stringify(v))

    const { error: planErr } = await P.client.from('crawls').update({ status: 'planned' }).eq('id', draftP)
    v = await sees(S.client, draftP)
    check("a PLANNED crawl is still owner-only", !planErr && !v.crawl && v.stops === 0, planErr?.message ?? JSON.stringify(v))

    const { data: sList } = await S.client.from('crawls').select('id, user_id')
    check("a stranger's unfiltered read returns no drafts of anyone's",
      !(sList ?? []).some((c) => c.id === draftP || c.id === draftQ))

    const { data: fBump } = await F.client.from('crawls').update({ title: 'Hijacked' }).eq('id', crawlQ).select('id')
    check("F can see Q's completed crawl but cannot rename it",
      (fBump ?? []).length === 0 && (await storedCrawl(crawlQ))?.title === 'Q walked')

    const { data: fDel } = await F.client.from('crawls').delete().eq('id', crawlQ).select('id')
    check("…or delete it", (fDel ?? []).length === 0 && !!(await storedCrawl(crawlQ)))

    const { error: fStopsErr } = await route(F, crawlQ, [{ exhibition_id: A }])
    check('…or touch its stops', refusedAs(fStopsErr, 'crawl_not_found'), fStopsErr?.message ?? 'accepted')

    // ─── 6. Likes ───────────────────────────────────────────────────────────

    section('6. Likes — gated like the crawl, counted for everyone, private per person')

    const { error: sLikeErr } = await like(S, crawlP)
    check("S likes P's completed crawl", !sLikeErr, sLikeErr?.message)
    const { error: sLikeAgainErr } = await like(S, crawlP)
    check('liking twice is harmless', !sLikeAgainErr, sLikeAgainErr?.message)
    const { error: fLikeErr } = await like(F, crawlP)
    check('F likes it too', !fLikeErr, fLikeErr?.message)

    let lc = await likeCount(anon, crawlP)
    check('the count is 2, even to a signed-out visitor', lc.row?.like_count === 2, JSON.stringify(lc))

    const { data: fSeesLikes } = await F.client.from('crawl_likes').select('user_id').eq('crawl_id', crawlP)
    check("F sees only her own like row, not S's",
      (fSeesLikes ?? []).length === 1 && fSeesLikes[0].user_id === F.id, JSON.stringify(fSeesLikes))

    await unlike(S, crawlP)
    lc = await likeCount(P.client, crawlP)
    check("S unlikes — the count drops to 1 and F's like is unaffected", lc.row?.like_count === 1, JSON.stringify(lc))

    const { error: ownLikeErr } = await like(P, crawlP)
    check('P cannot like her own crawl', refused(ownLikeErr), ownLikeErr?.message ?? 'accepted')

    const { error: draftLikeErr } = await like(S, draftP)
    check('nobody can like a draft', refused(draftLikeErr), draftLikeErr?.message ?? 'accepted')

    const { error: sQLikeErr } = await like(S, crawlQ)
    check("a stranger cannot like private Q's completed crawl", refused(sQLikeErr), sQLikeErr?.message ?? 'accepted')

    const { error: ghostLikeErr } = await like(S, '00000000-0000-0000-0000-000000000000')
    check('…and gets the same refusal as for a crawl that does not exist',
      refused(ghostLikeErr) && ghostLikeErr?.code === sQLikeErr?.code,
      `${sQLikeErr?.code} vs ${ghostLikeErr?.code}`)

    const { error: fQLikeErr } = await like(F, crawlQ)
    check("Q's approved follower can like it", !fQLikeErr, fQLikeErr?.message)

    lc = await likeCount(S.client, crawlQ)
    check("a stranger gets no count at all for Q's crawl (not even zero)", !lc.error && lc.row === null, JSON.stringify(lc))
    lc = await likeCount(S.client, draftP)
    check('nor for a draft', !lc.error && lc.row === null, JSON.stringify(lc))

    const { error: anonLikeErr } = await anon.from('crawl_likes').insert({ user_id: S.id, crawl_id: crawlP })
    check('a signed-out caller cannot like anything', refused(anonLikeErr), anonLikeErr?.message ?? 'accepted')

    const { error: forgeErr } = await S.client.from('crawl_likes').insert({ user_id: F.id, crawl_id: crawlP })
    check('S cannot place a like in somebody else\'s name', refused(forgeErr), forgeErr?.message ?? 'accepted')

    // ─── 7. Saves ───────────────────────────────────────────────────────────

    section('7. "Want to do this" — the same gate, private to the saver, copies nothing')

    const { error: sSaveErr } = await save(S, crawlP)
    check("S saves P's crawl", !sSaveErr, sSaveErr?.message)

    const { data: sSaves } = await S.client
      .from('crawl_saves')
      .select('crawl_id, crawls(id, title, profiles!crawls_user_id_fkey(username))')
      .eq('user_id', S.id)
    check("it comes back in S's saved list with the crawl and its owner",
      (sSaves ?? []).length === 1 && sSaves[0].crawls?.id === crawlP && sSaves[0].crawls?.profiles?.username === P.username,
      JSON.stringify(sSaves))

    const { data: pSeesSaves } = await P.client.from('crawl_saves').select('user_id').eq('crawl_id', crawlP)
    check("P (the owner) cannot see who saved her crawl", (pSeesSaves ?? []).length === 0)
    const { data: fSeesSaves } = await F.client.from('crawl_saves').select('user_id')
    check("F's saved list does not contain S's save", (fSeesSaves ?? []).length === 0)

    const { count: sCrawlCount } = await admin.from('crawls').select('id', { count: 'exact', head: true }).eq('user_id', S.id)
    check('saving copied nothing — S owns no crawls', sCrawlCount === 0, String(sCrawlCount))

    const { error: sQSaveErr } = await save(S, crawlQ)
    check("a stranger cannot save private Q's crawl", refused(sQSaveErr), sQSaveErr?.message ?? 'accepted')
    const { error: ownSaveErr } = await save(P, crawlP)
    check('P cannot save her own crawl', refused(ownSaveErr), ownSaveErr?.message ?? 'accepted')
    const { error: draftSaveErr } = await save(S, draftP)
    check('nobody can save a draft', refused(draftSaveErr), draftSaveErr?.message ?? 'accepted')

    // Losing access hides the save without deleting it.
    const { error: fQSaveErr } = await save(F, crawlQ)
    await Q.client.from('follows').delete().eq('follower_id', F.id).eq('followed_id', Q.id)
    const { data: fSavedAfter } = await F.client
      .from('crawl_saves').select('crawl_id, crawls(id)').eq('user_id', F.id)
    check("once Q removes F as a follower, F's save of Q's crawl no longer resolves to it",
      !fQSaveErr && (fSavedAfter ?? []).length === 1 && fSavedAfter[0].crawls === null,
      fQSaveErr?.message ?? JSON.stringify(fSavedAfter))
    v = await sees(F.client, crawlQ)
    check('…and F can no longer see the crawl itself', !v.crawl && v.stops === 0)

    // ─── 8. Blocking ────────────────────────────────────────────────────────

    section('8. A block hides the crawl and takes likes and saves with it')

    const { error: xLikeErr } = await like(X, crawlP)
    const { error: xSaveErr } = await save(X, crawlP)
    check('X likes and saves P\'s crawl', !xLikeErr && !xSaveErr, xLikeErr?.message ?? xSaveErr?.message)
    lc = await likeCount(anon, crawlP)
    const beforeBlock = lc.row?.like_count

    const { error: blockErr } = await P.client.from('blocks').insert({ blocker_id: P.id, blocked_id: X.id })
    check('P blocks X', !blockErr, blockErr?.message)

    v = await sees(X.client, crawlP)
    check("X can no longer see P's completed crawl or its stops", !v.crawl && v.stops === 0, JSON.stringify(v))

    const { data: xLikes } = await admin.from('crawl_likes').select('user_id').eq('user_id', X.id)
    const { data: xSaves } = await admin.from('crawl_saves').select('user_id').eq('user_id', X.id)
    check("X's like and save are gone", (xLikes ?? []).length === 0 && (xSaves ?? []).length === 0)
    lc = await likeCount(anon, crawlP)
    check('the public count dropped by one', lc.row?.like_count === beforeBlock - 1, `${beforeBlock} → ${lc.row?.like_count}`)

    const { error: xRelikeErr } = await like(X, crawlP)
    check('X cannot like it again', refused(xRelikeErr), xRelikeErr?.message ?? 'accepted')

    const { error: xRecreateErr } = await X.client.rpc('recreate_crawl', { p_crawl_id: crawlP })
    check('X cannot recreate it — same crawl_not_found as a missing crawl',
      refusedAs(xRecreateErr, 'crawl_not_found'), xRecreateErr?.message ?? 'accepted')

    // ─── 9. Recreate ────────────────────────────────────────────────────────

    section('9. Recreate — a new, independent draft; nothing personal copied')

    const { count: sLogsBefore } = await admin
      .from('exhibition_logs').select('exhibition_id', { count: 'exact', head: true }).eq('user_id', S.id)

    const { data: copyId, error: copyErr } = await S.client.rpc('recreate_crawl', { p_crawl_id: crawlP })
    check("S recreates P's completed crawl", !copyErr && typeof copyId === 'string', copyErr?.message)

    const copy = await storedCrawl(copyId)
    check('the copy belongs to S, is a draft, and has no completed_at',
      copy?.user_id === S.id && copy?.status === 'draft' && copy?.completed_at === null, JSON.stringify(copy))
    check('it carries the title', copy?.title === 'Chelsea loop, done', copy?.title)

    const copyStops = await storedStops(copyId)
    const origStops = await storedStops(crawlP)
    check('same stops, same order',
      copyStops.map((r) => r.exhibition_id).join() === origStops.map((r) => r.exhibition_id).join())
    check('same leg modes',
      copyStops.map((r) => r.arrive_by).join() === origStops.map((r) => r.arrive_by).join(),
      JSON.stringify(copyStops.map((r) => r.arrive_by)))

    const { count: sLogsAfter } = await admin
      .from('exhibition_logs').select('exhibition_id', { count: 'exact', head: true }).eq('user_id', S.id)
    check("no log entries were created or copied for S", sLogsAfter === sLogsBefore, `${sLogsBefore} → ${sLogsAfter}`)

    const { data: copyLikes } = await admin.from('crawl_likes').select('user_id').eq('crawl_id', copyId)
    check('no likes came with it', (copyLikes ?? []).length === 0)

    v = await sees(P.client, copyId)
    check("P cannot see S's copy — it is S's draft", !v.crawl && v.stops === 0)

    const { error: editCopyErr } = await route(S, copyId, [
      { exhibition_id: E }, { exhibition_id: A, arrive_by: 'driving' },
    ])
    check('S can edit her copy freely', !editCopyErr, editCopyErr?.message)
    const origAfter = await storedStops(crawlP)
    check("…and P's original is untouched", origAfter.map((r) => r.exhibition_id).join() === [A, B, C, D].join())

    const { data: fOwnCopy, error: pRecreateErr } = await P.client.rpc('recreate_crawl', { p_crawl_id: crawlP })
    check('the owner can recreate her own completed crawl as a new draft',
      !pRecreateErr && (await storedCrawl(fOwnCopy))?.status === 'draft', pRecreateErr?.message)

    const { error: draftCopyErr } = await S.client.rpc('recreate_crawl', { p_crawl_id: draftP })
    check('nobody can recreate a draft', refusedAs(draftCopyErr, 'crawl_not_found'), draftCopyErr?.message ?? 'accepted')

    const { error: qCopyErr } = await S.client.rpc('recreate_crawl', { p_crawl_id: crawlQ })
    check("a stranger cannot recreate private Q's crawl", refusedAs(qCopyErr, 'crawl_not_found'), qCopyErr?.message ?? 'accepted')

    const { error: anonCopyErr } = await anon.rpc('recreate_crawl', { p_crawl_id: crawlP })
    check('a signed-out caller cannot recreate', refused(anonCopyErr), anonCopyErr?.message ?? 'accepted')

    // ─── 10. Deleting a completed crawl ─────────────────────────────────────

    section('10. Deleting a completed crawl')

    const { error: delErr } = await P.client.from('crawls').delete().eq('id', crawlP)
    check('P can delete her completed crawl', !delErr, delErr?.message)

    const { data: leftLikes } = await admin.from('crawl_likes').select('user_id').eq('crawl_id', crawlP)
    const { data: leftSaves } = await admin.from('crawl_saves').select('user_id').eq('crawl_id', crawlP)
    check('its likes and saves went with it', (leftLikes ?? []).length === 0 && (leftSaves ?? []).length === 0)

    check("P's log entries from completing it stay — they are hers, not the crawl's",
      (await storedLog(P.id, A))?.status === 'seen')

    check("S's recreated copy is untouched", !!(await storedCrawl(copyId)))
  } finally {
    section('Cleanup')
    for (const person of people) {
      const { error } = await admin.auth.admin.deleteUser(person.id)
      console.log(error ? `  ! ${person.tag}: ${error.message}` : `  · removed ${person.username}`)
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
