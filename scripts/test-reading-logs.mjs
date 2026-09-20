/**
 * End-to-end check of migration_v63: the reading log, and the freeze it turns on.
 *
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs scripts/test-reading-logs.mjs
 *
 * RUN IT AFTER PASTING supabase/migration_v63.sql INTO THE SQL EDITOR. Like
 * scripts/test-exhibition-logs.mjs it talks to the live database over the REST
 * API with real signed-in sessions, which is the only way to exercise any of
 * this: the SQL editor runs as postgres and bypasses every policy and grant the
 * migration is made of.
 *
 * ── WHY THIS ONE IMPORTS APP CODE, WHERE PHASE 1's DID NOT ──────────────────
 *
 * The headline claim of this phase is not that a table exists. It is that the
 * PREREAD FREEZE, which has been dead code since e10444b, now fires — that
 * lib/preread-logs.ts stopped answering "nothing is logged" and started asking
 * the database. A test that re-implemented that query in this file would prove
 * the query works and say nothing about whether the repair path is asking it,
 * which is exactly what was broken. So section 10 imports the REAL
 * isPrereadLogged() and the REAL freeze writes from lib/preread-writes.ts and
 * runs the sequence lib/agent2.ts's freezeAndReplace() runs.
 *
 * It stops short of calling Agent 2 itself, deliberately: a real repair pays
 * for an Exa search and a Claude judgement, and rewrites a real show's
 * coverage. What is NOT covered is therefore the replacement SEARCH — which
 * this phase did not touch. Everything from "is it logged?" onwards is.
 *
 * ── WHAT IT WRITES TO PRODUCTION ────────────────────────────────────────────
 *
 * Four throwaway accounts, deleted in a finally block so a failure halfway
 * through still cleans up, taking their log rows with them through the cascade.
 *
 * AND — new in this script — two throwaway `prereads` rows on one real
 * published exhibition, because a preread has to exist to be logged and frozen,
 * and freezing a REAL one would leave a genuine article hidden behind a test.
 * Both are titled so nobody could mistake them, and both (plus any replacement
 * row the freeze creates) are deleted in the same finally block. They are
 * briefly visible on that exhibition's page while the script runs, which is a
 * few seconds; there is no other way to exercise a row-level rule against the
 * live database. Real prereads and real readings are READ and never written.
 */

import { createClient } from '@supabase/supabase-js'
import { isPrereadLogged, loggedPrereadIds } from '../lib/preread-logs.ts'
import { replacementInsert, freezeUpdate } from '../lib/preread-writes.ts'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !ANON || !SERVICE) {
  console.error('Missing Supabase env. Run with: node --env-file=.env.local')
  process.exit(1)
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

const MARK = `ZZ TEST ROW — reading-log test ${Date.now()} — safe to delete`

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
  const email = `rlog-test-${tag}-${Date.now()}@example.invalid`
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (createErr) throw new Error(`createUser(${tag}): ${createErr.message}`)

  const id = created.user.id
  const username = `rlogtest_${tag}_${id.slice(0, 6)}`

  const { error: profileErr } = await admin
    .from('profiles')
    .update({ username, display_name: `Reading Log Test ${tag.toUpperCase()}`, privacy })
    .eq('id', id)
  if (profileErr) throw new Error(`profile(${tag}): ${profileErr.message}`)

  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`signIn(${tag}): ${signInErr.message}`)

  return { tag, id, username, client }
}

/** Write a whole log row the way lib/reading-log-writes.ts does. */
function saveLog(person, item, row) {
  return person.client
    .from('reading_logs')
    .upsert(
      {
        user_id: person.id,
        content_type: item.type,
        content_id: item.id,
        status: row.status,
        rating: row.rating ?? null,
        liked: row.liked ?? false,
        comment: row.comment ?? null,
        comment_visibility: row.comment_visibility ?? null,
      },
      { onConflict: 'user_id,content_type,content_id' }
    )
}

/** Read a person's own row back. */
async function readOwn(person, item) {
  const { data } = await person.client
    .from('reading_logs')
    .select('status, rating, liked, comment, comment_visibility')
    .eq('user_id', person.id)
    .eq('content_type', item.type)
    .eq('content_id', item.id)
    .maybeSingle()
  return data
}

/** What `caller` can see of `target`'s reading log. `caller` null means signed out. */
async function logAsSeenBy(caller, targetId) {
  const client = caller
    ? caller.client
    : createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await client.rpc('profile_reading_logs', { profile_id: targetId })
  if (error) throw new Error(`profile_reading_logs: ${error.message}`)
  return data ?? []
}

const entryFor = (rows, item) =>
  rows.find((e) => e.content_type === item.type && e.content_id === item.id)

async function main() {
  const people = []
  const madePrereads = []

  try {
    section('Setting up')

    // Two real readings, untouched — only read and logged against.
    const { data: readings, error: readingErr } = await admin
      .from('readings')
      .select('id, headline')
      .order('created_at', { ascending: false })
      .limit(2)
    if (readingErr) throw new Error(`readings: ${readingErr.message}`)
    if (!readings || readings.length < 2) throw new Error('Need two readings to test against.')

    const article = { type: 'reading', id: readings[0].id }
    const otherArticle = { type: 'reading', id: readings[1].id }
    console.log(`  using reading "${readings[0].headline}" (${readings[0].id})`)

    // A real published exhibition to hang the throwaway prereads off.
    const { data: show, error: showErr } = await admin
      .from('exhibitions')
      .select('id, show_title')
      .eq('status', 'published')
      .limit(1)
      .maybeSingle()
    if (showErr) throw new Error(`exhibitions: ${showErr.message}`)
    if (!show) throw new Error('Need a published exhibition to attach a test preread to.')

    /** A throwaway preread row on that show. Deleted in the finally block. */
    async function makePreread(suffix, rowStatus = 'active') {
      const { data, error } = await admin
        .from('prereads')
        .insert({
          exhibition_id: show.id,
          article_title: `${MARK} (${suffix})`,
          publication: 'Test Publication',
          article_url: `https://example.invalid/reading-log-test/${Date.now()}-${suffix}`,
          row_status: rowStatus,
        })
        .select('id, article_title, publication, article_url, row_status, superseded_by')
        .single()
      if (error) throw new Error(`test preread (${suffix}): ${error.message}`)
      madePrereads.push(data.id)
      return data
    }

    const prereadRow = await makePreread('active')
    const blankedRow = await makePreread('blanked', 'blanked')
    const preread = { type: 'preread', id: prereadRow.id }
    console.log(`  made two test prereads on "${show.show_title}"`)

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
    // BOTH content types, explicitly. The brief asked for this by name: the
    // two live in different tables with different visibility rules, and a pass
    // on one says nothing about the other.
    section('1. Reading list / Read persists — for a READING (Top Stories, River)')

    const { error: wantErr } = await saveLog(A, article, { status: 'reading_list' })
    check('marking reading_list is accepted', !wantErr, wantErr?.message)

    let row = await readOwn(A, article)
    check('reading_list reads back', row?.status === 'reading_list', JSON.stringify(row))

    const { error: readErr } = await saveLog(A, article, {
      status: 'read', rating: 4, liked: true,
      comment: 'A public note from A about an article.', comment_visibility: 'public',
    })
    check('upgrading to read with rating, like and note is accepted', !readErr, readErr?.message)

    row = await readOwn(A, article)
    check('read, rating 4, liked and the note all read back',
      row?.status === 'read' && row?.rating === 4 && row?.liked === true &&
        row?.comment === 'A public note from A about an article.' &&
        row?.comment_visibility === 'public',
      JSON.stringify(row))

    // ───────────────────────────────────────────────────────────────────────
    section('2. ...and for a PREREAD, which is a different table entirely')

    const { error: pWantErr } = await saveLog(A, preread, { status: 'reading_list' })
    check('marking a preread reading_list is accepted', !pWantErr, pWantErr?.message)

    row = await readOwn(A, preread)
    check('the preread reads back at reading_list', row?.status === 'reading_list', JSON.stringify(row))

    const { error: pReadErr } = await saveLog(A, preread, {
      status: 'read', rating: 5, liked: true,
      comment: 'A public note from A about a preread.', comment_visibility: 'public',
    })
    check('upgrading the preread to read is accepted', !pReadErr, pReadErr?.message)

    row = await readOwn(A, preread)
    check('the preread reads back at read with its rating and note',
      row?.status === 'read' && row?.rating === 5 &&
        row?.comment === 'A public note from A about a preread.',
      JSON.stringify(row))

    // The pair is the key, so the two live side by side without colliding.
    const { count: bothCount } = await admin
      .from('reading_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', A.id)
    check('both content types coexist in one person\'s log', bothCount === 2, `count=${bothCount}`)

    // ───────────────────────────────────────────────────────────────────────
    section('3. The gate REJECTS — it does not quietly tidy')

    const rejected = async (label, item, body) => {
      const { error } = await saveLog(A, item, body)
      check(label, !!error, error ? undefined : 'the write was ACCEPTED')
    }

    await rejected('a rating at reading_list is refused', otherArticle,
      { status: 'reading_list', rating: 5 })
    await rejected('a like at reading_list is refused', otherArticle,
      { status: 'reading_list', liked: true })
    await rejected('a note at reading_list is refused', otherArticle,
      { status: 'reading_list', comment: 'nope', comment_visibility: 'public' })
    await rejected('a rating of 6 is refused', otherArticle,
      { status: 'read', rating: 6 })
    await rejected('a rating of 0 is refused', otherArticle,
      { status: 'read', rating: 0 })
    await rejected('a note with no visibility is refused', otherArticle,
      { status: 'read', comment: 'nope' })
    await rejected('a visibility with no note is refused', otherArticle,
      { status: 'read', comment_visibility: 'private' })
    await rejected('an invented status is refused', otherArticle,
      { status: 'skimmed' })

    // And the polymorphic key's own version of the same idea.
    const { error: typeErr } = await A.client.from('reading_logs').insert({
      user_id: A.id, content_type: 'exhibition', content_id: article.id, status: 'read',
    })
    check('an invented content_type is refused', !!typeErr, typeErr ? undefined : 'ACCEPTED')

    const strayRow = await readOwn(A, otherArticle)
    check('none of the refused writes created a row', strayRow === null, JSON.stringify(strayRow))

    // ───────────────────────────────────────────────────────────────────────
    section('4. Going back to the reading list clears the opinion')

    const { error: downErr } = await saveLog(A, article, {
      status: 'reading_list', rating: null, liked: false, comment: null, comment_visibility: null,
    })
    check('downgrading with explicit nulls is accepted', !downErr, downErr?.message)

    row = await readOwn(A, article)
    check('rating, like and note are GONE, not hidden',
      row?.status === 'reading_list' && row?.rating === null &&
        row?.liked === false && row?.comment === null,
      JSON.stringify(row))

    // The documented consequence: a PARTIAL downgrade fails loudly rather than
    // silently keeping an opinion about something you have not read.
    await saveLog(A, article, {
      status: 'read', rating: 3, liked: false, comment: null, comment_visibility: null,
    })
    const { error: partialErr } = await A.client
      .from('reading_logs')
      .update({ status: 'reading_list' })
      .eq('user_id', A.id)
      .eq('content_type', article.type)
      .eq('content_id', article.id)
    check('a PARTIAL downgrade that leaves a rating behind is refused',
      !!partialErr, partialErr ? undefined : 'the write was ACCEPTED')

    // ───────────────────────────────────────────────────────────────────────
    section('5. One row per person per content_type + content_id')

    const { error: dupErr } = await A.client.from('reading_logs').insert({
      user_id: A.id, content_type: article.type, content_id: article.id, status: 'read',
    })
    check('a second insert for the same triple is refused', !!dupErr, dupErr ? undefined : 'ACCEPTED')

    const { count } = await admin
      .from('reading_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', A.id)
      .eq('content_type', article.type)
      .eq('content_id', article.id)
    check('exactly one row exists for that triple', count === 1, `count=${count}`)

    // ───────────────────────────────────────────────────────────────────────
    section('6. Nobody reads anybody else\'s row from the table')

    const { data: peeked } = await B.client
      .from('reading_logs')
      .select('user_id, content_id, comment')
      .eq('user_id', A.id)
    check('B cannot select A\'s rows directly', (peeked ?? []).length === 0,
      `${(peeked ?? []).length} rows came back`)

    const { error: forgeErr } = await B.client.from('reading_logs').insert({
      user_id: A.id, content_type: otherArticle.type, content_id: otherArticle.id, status: 'read',
    })
    check('B cannot write a row as A', !!forgeErr, forgeErr ? undefined : 'ACCEPTED')

    // ───────────────────────────────────────────────────────────────────────
    // The same cases as scripts/test-exhibition-logs.mjs section 6, run
    // against reading_logs. The brief asked for exactly that: the rule is
    // supposed to be the same rule, so it is checked with the same questions.
    section('7. Comment visibility, nested inside profile privacy')

    await saveLog(A, article, {
      status: 'read', rating: 5, liked: true,
      comment: 'A public note from A.', comment_visibility: 'public',
    })
    await saveLog(A, otherArticle, {
      status: 'read', comment: 'A PRIVATE note from A.', comment_visibility: 'private',
    })

    const aSeenByB = await logAsSeenBy(B, A.id)
    const aPublic = entryFor(aSeenByB, article)
    const aPrivate = entryFor(aSeenByB, otherArticle)

    check('a stranger sees a public profile\'s reading log', aSeenByB.length === 3,
      `${aSeenByB.length} rows`)
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
      entryFor(aSeenByA, otherArticle)?.comment === 'A PRIVATE note from A.')
    check('A\'s own private note is labelled private to A',
      entryFor(aSeenByA, otherArticle)?.comment_visibility === 'private')

    const aSeenByAnon = await logAsSeenBy(null, A.id)
    check('a signed-out visitor sees a public profile\'s public note',
      entryFor(aSeenByAnon, article)?.comment === 'A public note from A.')
    check('a signed-out visitor cannot read a private note',
      entryFor(aSeenByAnon, otherArticle)?.comment === null)

    // The preread branch of the function obeys the same rule as the reading one.
    check('a stranger can read a public note on a PREREAD entry',
      entryFor(aSeenByB, preread)?.comment === 'A public note from A about a preread.',
      JSON.stringify(entryFor(aSeenByB, preread)))

    // ───────────────────────────────────────────────────────────────────────
    section('8. A PUBLIC note on a PRIVATE profile is not public')

    await saveLog(P, article, {
      status: 'read', rating: 3,
      comment: 'A PUBLIC note on a PRIVATE profile.', comment_visibility: 'public',
    })
    await saveLog(P, preread, {
      status: 'read',
      comment: 'A private note on a private profile.', comment_visibility: 'private',
    })

    check('a non-follower sees NOTHING of a private profile\'s reading log',
      (await logAsSeenBy(B, P.id)).length === 0)
    check('a signed-out visitor sees nothing of a private profile\'s reading log',
      (await logAsSeenBy(null, P.id)).length === 0)

    const pSeenByF = await logAsSeenBy(F, P.id)
    check('an APPROVED follower sees the private profile\'s reading log',
      pSeenByF.length === 2, `${pSeenByF.length} rows`)
    check('the approved follower reads the public note',
      entryFor(pSeenByF, article)?.comment === 'A PUBLIC note on a PRIVATE profile.')
    check('the approved follower does NOT read the private note',
      entryFor(pSeenByF, preread)?.comment === null)

    // ───────────────────────────────────────────────────────────────────────
    section('9. A block closes the reading log too')

    await saveLog(B, article, {
      status: 'read', comment: 'A public note from B.', comment_visibility: 'public',
    })
    check('B\'s reading log is visible to A before any block',
      (await logAsSeenBy(A, B.id)).length === 1)

    const { error: blockErr } = await A.client
      .from('blocks')
      .insert({ blocker_id: A.id, blocked_id: B.id })
    if (blockErr) throw new Error(`block: ${blockErr.message}`)

    check('a blocked account sees none of the blocker\'s reading log',
      (await logAsSeenBy(B, A.id)).length === 0)
    check('the blocker sees none of the blocked account\'s reading log',
      (await logAsSeenBy(A, B.id)).length === 0)

    await A.client.from('blocks').delete().eq('blocker_id', A.id).eq('blocked_id', B.id)
    check('unblocking restores the reading log',
      (await logAsSeenBy(B, A.id)).length === 3)

    // ───────────────────────────────────────────────────────────────────────
    section('10. Only something you were actually shown can be logged')

    const { error: ghostErr } = await saveLog(
      A, { type: 'reading', id: '00000000-0000-0000-0000-000000000000' }, { status: 'reading_list' })
    check('logging a reading that does not exist is refused', !!ghostErr,
      ghostErr ? undefined : 'ACCEPTED')

    const { error: ghostPrereadErr } = await saveLog(
      A, { type: 'preread', id: '00000000-0000-0000-0000-000000000000' }, { status: 'reading_list' })
    check('logging a preread that does not exist is refused', !!ghostPrereadErr,
      ghostPrereadErr ? undefined : 'ACCEPTED')

    const { error: blankedErr } = await saveLog(
      A, { type: 'preread', id: blankedRow.id }, { status: 'reading_list' })
    check('logging a BLANKED preread is refused — it is admin-only', !!blankedErr,
      blankedErr ? undefined : 'ACCEPTED')

    // A preread id used as a reading id, and vice versa: the pair is the key,
    // so each must be refused by the branch that does not know it.
    const { error: crossErr } = await saveLog(
      A, { type: 'reading', id: prereadRow.id }, { status: 'reading_list' })
    check('a preread id logged as a reading is refused', !!crossErr,
      crossErr ? undefined : 'ACCEPTED')

    // ───────────────────────────────────────────────────────────────────────
    // THE CRITICAL SECTION FOR THIS PHASE.
    section('11. THE FREEZE IS LIVE — the stub now answers from the database')

    // The real function out of lib/preread-logs.ts, not a copy of its query.
    check('isPrereadLogged() says TRUE for a preread A has logged',
      (await isPrereadLogged(prereadRow.id)) === true)
    check('isPrereadLogged() says FALSE for one nobody has logged',
      (await isPrereadLogged(blankedRow.id)) === false)

    const batch = await loggedPrereadIds([prereadRow.id, blankedRow.id])
    check('loggedPrereadIds() picks out only the logged one',
      batch.size === 1 && batch.has(prereadRow.id), `${[...batch].join(', ')}`)

    // Now the sequence lib/agent2.ts's freezeAndReplace() runs, using its own
    // helpers: insert the replacement first, then freeze the logged row.
    const fresh = {
      article_title: `${MARK} (replacement)`,
      publication: 'Test Publication',
      article_url: `https://example.invalid/reading-log-test/${Date.now()}-replacement`,
      thumbnail_url: null,
      summary: null,
    }

    const { data: inserted, error: insertErr } = await admin
      .from('prereads')
      .insert(replacementInsert(show.id, fresh, null))
      .select('id, article_title, row_status')
      .single()
    if (insertErr) throw new Error(`replacement insert: ${insertErr.message}`)
    madePrereads.push(inserted.id)

    const { error: freezeErr } = await admin
      .from('prereads')
      .update(freezeUpdate(inserted.id))
      .eq('id', prereadRow.id)
    check('the logged row is frozen without error', !freezeErr, freezeErr?.message)

    const { data: frozen } = await admin
      .from('prereads')
      .select('id, article_title, publication, article_url, row_status, superseded_by')
      .eq('id', prereadRow.id)
      .single()

    check('a NEW row was created for the fresh article',
      inserted.id !== prereadRow.id && inserted.row_status === 'active')
    check('the logged row still EXISTS', !!frozen)
    check('the logged row is now hidden from the public page',
      frozen?.row_status === 'blanked', frozen?.row_status)
    check('the logged row points at its replacement',
      frozen?.superseded_by === inserted.id, `${frozen?.superseded_by}`)
    check('the logged row\'s CONTENT is untouched — same article, byte for byte',
      frozen?.article_title === prereadRow.article_title &&
        frozen?.article_url === prereadRow.article_url &&
        frozen?.publication === prereadRow.publication,
      JSON.stringify(frozen))

    // And the freeze does not fire twice: a frozen row is out of the repair
    // pool, so the next run must not produce another replacement.
    check('the frozen row is excluded from the flagged-rows query by superseded_by',
      (await admin.from('prereads').select('id')
        .eq('exhibition_id', show.id).is('superseded_by', null)
        .eq('id', prereadRow.id)).data?.length === 0)

    // ───────────────────────────────────────────────────────────────────────
    section('12. A frozen preread still renders in the log that points at it')

    const afterFreeze = await readOwn(A, preread)
    check('A\'s own log row survived the freeze',
      afterFreeze?.status === 'read' && afterFreeze?.rating === 5,
      JSON.stringify(afterFreeze))

    const aAfter = await logAsSeenBy(B, A.id)
    const frozenEntry = entryFor(aAfter, preread)
    check('the frozen preread still appears on A\'s profile', !!frozenEntry)
    check('...with the ORIGINAL article the person read, not the replacement',
      frozenEntry?.title === prereadRow.article_title, `${frozenEntry?.title}`)
    check('...flagged as superseded, so the page can say so',
      frozenEntry?.superseded === true, `${frozenEntry?.superseded}`)
    check('...and it still carries the note and rating',
      frozenEntry?.rating === 5 &&
        frozenEntry?.comment === 'A public note from A about a preread.')

    // The subtle one: a frozen preread must stay EDITABLE by the person who
    // logged it. The loggable trigger fires on every upsert, and if it
    // re-checked "is this row still active?" the log would be frozen shut.
    const { error: editErr } = await saveLog(A, preread, {
      status: 'read', rating: 2, liked: false,
      comment: 'Changed my mind about the piece I read.', comment_visibility: 'public',
    })
    check('the person can still change their rating on a frozen preread',
      !editErr, editErr?.message)

    const edited = await readOwn(A, preread)
    check('the change was saved', edited?.rating === 2, JSON.stringify(edited))

    const { error: removeErr } = await A.client
      .from('reading_logs')
      .delete()
      .eq('user_id', A.id)
      .eq('content_type', 'preread')
      .eq('content_id', prereadRow.id)
    check('and they can remove it entirely', !removeErr, removeErr?.message)

  } finally {
    section('Cleaning up')

    // The prereads first: log rows referencing them cascade away with the
    // accounts below, and there is no FK either way, so the order is only
    // about leaving nothing behind on a real exhibition page.
    if (madePrereads.length > 0) {
      // superseded_by is ON DELETE SET NULL, so deleting the replacement first
      // cannot take the frozen row with it.
      const { error } = await admin.from('prereads').delete().in('id', madePrereads)
      if (error) console.log(`  ! could not delete test prereads: ${error.message}`)
      else console.log(`  removed ${madePrereads.length} test preread rows`)
    }

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
