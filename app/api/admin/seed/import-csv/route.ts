import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// POST /api/admin/seed/import-csv
//
// Turns the enriched gallery CSV into the same shape /api/admin/seed/suggest
// returns, so the existing seed review table, geocode step and insert route all
// work on it unchanged. Nothing is written here — this endpoint only reads.
//
// body: {
//   csv?: string            paste the file instead of reading it from disk
//   status?: string[]       default ['open'] — 'closed' is never included unless asked for
//   search?: string
//   offset?: number, limit?: number   default 25 at a time
//   exclude_duplicates?: boolean      default true
// }
//
// Batching is not decoration. The file holds 817 rows across ~700 institutions,
// and the review table is meant to be read before anything is inserted.

export const maxDuration = 60

const DEFAULT_CSV = 'seed-data/enriched-nyc-galleries.csv'

function parseCsv(t: string): string[][] {
  const rows: string[][] = []
  let f = '', row: string[] = [], q = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = '' }
    else if (c !== '\r') f += c
  }
  if (f || row.length) { row.push(f); rows.push(row) }
  return rows.filter((r) => r.length > 1)
}

// Mirrors the dedup rule in ../insert/route.ts so the preview reports the same
// collisions the insert would hit, rather than showing rows that will be skipped.
// "28 Warren Street, New York, NY 10007" → "28 Warren Street". Used to tell two
// venues of the same gallery apart when the CSV carries no location label.
function streetLine(address: string): string {
  return address.split(',')[0].trim() || address.trim()
}

function normalizeForDedup(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(the|gallery|galleries|museum|museums|art|arts|foundation|institute|center|centre|studio|studios|project|projects|space|spaces|inc|llc|and|&)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const body = await request.json().catch(() => ({}))
  const statuses: string[] = Array.isArray(body.status) && body.status.length ? body.status : ['open']
  const search: string = typeof body.search === 'string' ? body.search.trim().toLowerCase() : ''
  const excludeDuplicates = body.exclude_duplicates !== false
  const offset = Number.isFinite(body.offset) ? Math.max(0, Number(body.offset)) : 0
  const limit = Number.isFinite(body.limit) ? Math.min(100, Math.max(1, Number(body.limit))) : 25

  let text: string = typeof body.csv === 'string' && body.csv.trim() ? body.csv : ''
  if (!text) {
    try {
      text = await readFile(resolve(process.cwd(), DEFAULT_CSV), 'utf8')
    } catch {
      return NextResponse.json(
        { error: `Could not read ${DEFAULT_CSV} on the server. Paste the CSV contents instead.` },
        { status: 404 }
      )
    }
  }

  const rows = parseCsv(text)
  if (rows.length < 2) return NextResponse.json({ error: 'CSV has no data rows' }, { status: 400 })

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const iName = col('name'), iAddr = col('address'), iSite = col('website')
  const iStatus = col('status'), iLabel = col('location_label'), iCity = col('city')
  if (iName === -1 || iAddr === -1) {
    return NextResponse.json({ error: 'CSV must have at least name and address columns' }, { status: 400 })
  }

  const data = rows.slice(1)

  // Group rows into one institution per name, each row becoming a venue. This is
  // what turns the enrichment's per-location rows back into the institution +
  // venues shape the rest of the seed flow expects.
  const grouped = new Map<string, {
    name: string; website: string; status: string; aliases: Set<string>
    venues: { label: string; address: string; city: string }[]
  }>()

  // Grouped on the dedup key rather than the literal name, so the same gallery
  // arriving under two spellings becomes one institution with the union of its
  // venues. The list holds nine such pairs — "Andrew Kreps" and "Andrew Kreps
  // Gallery", "Michael Werner" and "Michael Werner Gallery" — because Artguide
  // and the added-majors list name them differently. Grouping on the literal
  // name would insert each twice.
  for (const r of data) {
    const name = (r[iName] ?? '').trim()
    if (!name) continue
    const status = iStatus === -1 ? 'open' : (r[iStatus] ?? '').trim() || 'open'
    if (!statuses.includes(status)) continue
    if (search && !name.toLowerCase().includes(search)) continue

    const key = normalizeForDedup(name) || name.toLowerCase()
    if (!grouped.has(key)) {
      grouped.set(key, { name, website: (r[iSite] ?? '').trim(), status, aliases: new Set(), venues: [] })
    }
    const g = grouped.get(key)!
    g.aliases.add(name)
    // Prefer the fuller spelling as the display name — "Andrew Kreps Gallery"
    // over "Andrew Kreps".
    if (name.length > g.name.length) g.name = name
    if (!g.website && (r[iSite] ?? '').trim()) g.website = (r[iSite] ?? '').trim()

    const address = (r[iAddr] ?? '').trim()
    // A street address has a number in it. Extraction sometimes yields a bare
    // city — Almine Rech came through as "New York" — which is not a venue.
    if (!address || !/\d/.test(address)) continue
    if (!g.venues.some((v) => v.address.toLowerCase() === address.toLowerCase())) {
      g.venues.push({ label: iLabel === -1 ? '' : (r[iLabel] ?? '').trim(), address, city: iCity === -1 ? '' : (r[iCity] ?? '').trim() })
    }
  }

  const all = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name))

  // Flag what already exists rather than filtering it out — seeing "already in
  // your database" is more useful than a row silently vanishing.
  const db = getSupabaseAdmin()
  const [{ data: existingInst }, { data: existingVen }] = await Promise.all([
    db.from('institutions').select('name'),
    db.from('venues').select('address'),
  ])
  const instKeys = new Set((existingInst ?? []).map((i) => normalizeForDedup(i.name as string)))
  // Galleries rejected in a previous session. Without this the review table
  // re-offers them on every load and the list never gets shorter.
  const { data: exclusions } = await db.from('seed_exclusions').select('dedup_key')
  const excludedKeys = new Set((exclusions ?? []).map((e) => e.dedup_key as string))
  const addrKeys = new Set((existingVen ?? []).map((v) => (v.address as string ?? '').toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean))

  const annotated = all.map((g) => ({
    ...g,
    already_present: instKeys.has(normalizeForDedup(g.name)),
    venues: g.venues.map((v) => ({ ...v, already_present: addrKeys.has(v.address.toLowerCase().replace(/\s+/g, ' ').trim()) })),
  }))

  // Institutions already in the database are removed rather than shown greyed
  // out. Venue-level address matches are left alone: NYC galleries genuinely
  // share buildings — 105 Henry Street houses three — so a matching address is
  // not evidence of a duplicate gallery.
  const duplicatesRemoved = annotated.filter((g) => g.already_present).length
  const notExcluded = annotated.filter((g) => !excludedKeys.has(normalizeForDedup(g.name)))
  const excludedRemoved = annotated.length - notExcluded.length
  const visible = excludeDuplicates ? notExcluded.filter((g) => !g.already_present) : notExcluded
  const page = visible.slice(offset, offset + limit)

  // Same field names institutionFromRaw() expects, so SeedTool can map this with
  // the code it already uses for suggest results.
  const institutions = page.map((g) => {
    const site = g.website.replace(/\/$/, '')
    const venues = g.venues.length ? g.venues : [{ label: '', address: '', city: '' }]
    const multiVenue = venues.length > 1
    return {
      name: g.name,
      website: g.website,
      type: 'gallery',
      _dupWarning: g.already_present ? 'An institution with this name already exists' : undefined,
      venues: venues.map((v, i) => ({
        // Two locations of one gallery arrive with the same institution name and
        // no label, which made both venues identically named and impossible to
        // tell apart in review. Fall back to the street line.
        name: v.label
          ? `${g.name} — ${v.label}`
          : multiVenue
            ? `${g.name} — ${streetLine(v.address)}`
            : g.name,
        // A guess, and marked as one in the UI: most gallery sites use /exhibitions,
        // but Agent 1 will scrape whatever ends up here on a schedule, so a wrong
        // value is a recurring 404 rather than a one-off. Meant to be checked.
        //
        // Only the first venue gets it. exhibitions_url is unique per venue —
        // both in the database and in seed/insert's dedup — so repeating the
        // same guess across a multi-location gallery made the insert silently
        // skip every venue after the first. A blank the reviewer has to fill in
        // is better than a duplicate that drops the row.
        exhibitions_url: i === 0 && site ? `${site}/exhibitions` : '',
        address: v.address,
        neighborhood: '',
        latitude: '',
        longitude: '',
      })),
    }
  })

  return NextResponse.json({
    institutions,
    total: visible.length,
    offset,
    limit,
    returned: page.length,
    already_present: duplicatesRemoved,
    duplicates_excluded: excludeDuplicates ? duplicatesRemoved : 0,
    manually_excluded: excludedRemoved,
    merged_aliases: all.filter((g) => g.aliases.size > 1).map((g) => [...g.aliases]),
    counts_by_status: data.reduce((acc: Record<string, number>, r) => {
      const s = iStatus === -1 ? 'open' : (r[iStatus] ?? '').trim() || 'open'
      acc[s] = (acc[s] ?? 0) + 1
      return acc
    }, {}),
  })
}
