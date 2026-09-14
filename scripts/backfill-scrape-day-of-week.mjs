#!/usr/bin/env node
/**
 * ONE-TIME backfill — give every venue a permanent weekly scrape slot
 * (venues.scrape_day_of_week, migration_v38), spread evenly across all 7 days.
 *
 *     node scripts/backfill-scrape-day-of-week.mjs            # dry run — prints only
 *     node scripts/backfill-scrape-day-of-week.mjs --execute  # writes
 *
 * WHY EVEN, NOT JUST RANDOM
 * Agent 1's check_back_date values are clustered: the last full drain on
 * 2026-09-01 left every automatable venue due on the same day (2026-09-08).
 * Independently random days would still leave some days carrying far more than
 * others at this venue count. Instead venues are dealt in random order onto the
 * least-loaded day, with a random tie-break, so no two days differ by more than
 * one venue and which venue lands where is still random.
 *
 * check_back_date is left alone. Every current value is already in the past, so
 * it passes the queue's check-back gate on whatever day a venue is assigned —
 * the weekday slot, not check_back_date, is what spreads the load from here on.
 *
 * NEVER RE-RANDOMIZES
 * Only venues whose scrape_day_of_week IS NULL are assigned, and each write is
 * conditional on it still being NULL. Venues created after migration_v38 get a
 * random day from the column default; they count toward the day loads here and
 * are never moved. Re-running after a successful --execute is a no-op.
 *
 * Covers every venue, active or not.
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { randomInt } from 'node:crypto'

dotenv.config({ path: '.env.local' })

const EXECUTE = process.argv.includes('--execute')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function countBy(rows, keyOf, keys) {
  const counts = new Map(keys.map((k) => [k, 0]))
  for (const row of rows) {
    const key = keyOf(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function printDistribution(label, counts) {
  console.log(`\n${label}`)
  for (const [key, n] of counts) {
    console.log(`  ${String(key).padEnd(5)} ${String(n).padStart(3)}  ${'#'.repeat(n)}`)
  }
}

const slotLabel = (v) => (v.scrape_day_of_week === null ? 'none' : DAYS[v.scrape_day_of_week])
const checkBackLabel = (v) =>
  v.check_back_date ? DAYS[new Date(`${v.check_back_date}T00:00:00Z`).getUTCDay()] : 'none'

async function loadVenues() {
  const withSlot = await db
    .from('venues')
    .select('id, name, active, check_back_date, scrape_day_of_week')
    .order('name')
  if (!withSlot.error) return { venues: withSlot.data, columnExists: true }

  // 42703 = undefined column: migration_v38 has not been applied yet.
  if (withSlot.error.code !== '42703') throw new Error(withSlot.error.message)
  const without = await db.from('venues').select('id, name, active, check_back_date').order('name')
  if (without.error) throw new Error(without.error.message)
  return { venues: without.data.map((v) => ({ ...v, scrape_day_of_week: null })), columnExists: false }
}

async function main() {
  const { venues, columnExists } = await loadVenues()
  console.log(`${venues.length} venues (${venues.filter((v) => v.active).length} active)`)
  if (!columnExists) {
    console.log('venues.scrape_day_of_week does not exist yet — apply supabase/migration_v38.sql before --execute.')
    console.log('Dry run continues with every venue treated as unassigned.')
  }

  printDistribution('BEFORE — check_back_date weekday (the clustering this corrects)',
    countBy(venues, checkBackLabel, [...DAYS, 'none']))
  printDistribution('BEFORE — scrape_day_of_week', countBy(venues, slotLabel, [...DAYS, 'none']))

  const load = DAYS.map((_, day) => venues.filter((v) => v.scrape_day_of_week === day).length)
  const unassigned = venues.filter((v) => v.scrape_day_of_week === null)
  for (let i = unassigned.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[unassigned[i], unassigned[j]] = [unassigned[j], unassigned[i]]
  }

  const plan = unassigned.map((venue) => {
    const min = Math.min(...load)
    const leastLoaded = load.flatMap((n, day) => (n === min ? [day] : []))
    const day = leastLoaded[randomInt(leastLoaded.length)]
    load[day]++
    return { ...venue, day }
  })

  const projected = [
    ...venues.filter((v) => v.scrape_day_of_week !== null),
    ...plan.map((p) => ({ ...p, scrape_day_of_week: p.day })),
  ]
  printDistribution(EXECUTE ? 'PLANNED' : 'AFTER (projected — dry run, nothing written)',
    countBy(projected, slotLabel, DAYS))

  console.log(`\n${plan.length} venue(s) to assign:`)
  for (const p of [...plan].sort((a, b) => a.day - b.day || a.name.localeCompare(b.name))) {
    console.log(`  ${DAYS[p.day]}  ${p.name}${p.active ? '' : '  (inactive)'}`)
  }

  if (!EXECUTE) {
    console.log('\nDry run — nothing written. Re-run with --execute to apply.')
    return
  }
  if (!columnExists) {
    console.error('\nRefusing to execute: migration_v38 is not applied.')
    process.exit(1)
  }

  let written = 0
  let skipped = 0
  for (const p of plan) {
    const { data, error } = await db
      .from('venues')
      .update({ scrape_day_of_week: p.day })
      .eq('id', p.id)
      .is('scrape_day_of_week', null)
      .select('id')
    if (error) {
      console.error(`  ${p.name}: ${error.message}`)
      continue
    }
    if (data.length === 1) written++
    else skipped++
  }
  console.log(`\nWrote ${written}; skipped ${skipped} already assigned by the time of the write.`)

  const after = await loadVenues()
  printDistribution('AFTER — scrape_day_of_week (re-read from the database)',
    countBy(after.venues, slotLabel, [...DAYS, 'none']))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
