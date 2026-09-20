/**
 * Regenerate supabase/SCHEMA-CURRENT.md from the live database.
 *
 *   node --env-file=.env.local scripts/dump-schema.mjs
 *
 * WHY THIS EXISTS. supabase/schema.sql is the v1 schema and stopped being true
 * somewhere around migration_v2. It still declares three tables and columns
 * that no longer exist, and reading it has already cost real time: a test was
 * written against exhibitions.last_fetched_at, which comes from that file and
 * is not a column of the live table. The truth lives in the numbered
 * migrations, but sixty of them are a poor way to answer "what columns does
 * this table have today".
 *
 * WHAT IT READS. PostgREST publishes an OpenAPI description of everything it
 * serves, and that description is generated from the live catalog rather than
 * from any file in this repo, so it cannot drift. It carries column names,
 * SQL types, nullability, defaults, primary and foreign keys, and the COMMENT
 * on every table and column.
 *
 * WHAT IT CANNOT SEE, and why the output says so in its own header rather than
 * quietly omitting it:
 *
 *   · CHECK constraints      — the gating rule on exhibition_logs is a CHECK,
 *                              and nothing here would show it
 *   · RLS policies and grants — the entire privacy model
 *   · triggers and functions  — only a function's NAME appears, as an endpoint
 *   · indexes
 *
 * All four live in the migrations, and for anything that decides ACCESS the
 * migration is the only honest source. This file answers "what shape is this
 * table", not "who may read it".
 *
 * It is also why the output is Markdown and not .sql: a .sql file invites
 * somebody to run it, and running this one would build a database with no
 * constraints, no policies and no triggers — a quiet disaster. Markdown cannot
 * be mistaken for DDL.
 */

import { writeFileSync } from 'node:fs'

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_BASE || !KEY) {
  console.error('Missing Supabase env. Run with: node --env-file=.env.local')
  process.exit(1)
}

const res = await fetch(`${URL_BASE}/rest/v1/`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
})
if (!res.ok) {
  console.error(`OpenAPI fetch failed: ${res.status} ${res.statusText}`)
  process.exit(1)
}
const spec = await res.json()

/** PostgREST hides the key facts in prose inside `description`. Pull them out. */
function keyNotes(desc = '') {
  const pk = /<pk\//.test(desc)
  const fk = desc.match(/<fk table='([^']+)' column='([^']+)'\/>/)
  const bits = []
  if (pk) bits.push('PK')
  if (fk) bits.push(`FK → ${fk[1]}.${fk[2]}`)
  return bits.join(', ')
}

/** Everything in `description` that is not one of those machine notes. */
function humanComment(desc = '') {
  return desc
    .replace(/Note:\n?/g, '')
    .replace(/This is a Primary Key\.<pk\/>/g, '')
    .replace(/This is a Foreign Key to `[^`]+`\.<fk[^>]*\/>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const tables = Object.entries(spec.definitions ?? {}).sort(([a], [b]) => a.localeCompare(b))

const rpcs = Object.keys(spec.paths ?? {})
  .filter((p) => p.startsWith('/rpc/'))
  .map((p) => p.slice(5))
  .sort()

const today = new Date().toISOString().slice(0, 10)

let out = `# Current database schema

**Generated from the live database on ${today}** by \`scripts/dump-schema.mjs\`.
Do not edit by hand — re-run the script instead.

## Read this before you trust it

This is a **shape reference**, not a definition of the database and not
something to run. It is derived from what PostgREST serves, which is the live
catalog, so the columns and types below are true. But it **cannot see**:

- **CHECK constraints** — including the gating rule on \`exhibition_logs\`
- **RLS policies and grants** — i.e. the entire privacy model
- **Triggers and function bodies** — only a function's name appears, under RPCs
- **Indexes**

For anything that decides **access**, read the migration. \`supabase/migration_v*.sql\`
is the source of truth and each one explains its own reasoning at the top.

\`supabase/schema.sql\` is the **v1** schema and is long out of date — it
declares three tables and columns that do not exist. Do not read it as current.

---

## Tables (${tables.length})

`

for (const [name, def] of tables) {
  const comment = humanComment(def.description ?? '')
  const required = new Set(def.required ?? [])
  out += `### \`${name}\`\n\n`
  if (comment) out += `> ${comment}\n\n`
  out += `| Column | Type | Null | Default | Key |\n|---|---|---|---|---|\n`

  for (const [col, p] of Object.entries(def.properties ?? {})) {
    const type = p.format ?? p.type ?? '?'
    const nullable = required.has(col) ? 'NOT NULL' : ''
    const dflt = p.default !== undefined ? `\`${JSON.stringify(p.default)}\`` : ''
    out += `| \`${col}\` | ${type} | ${nullable} | ${dflt} | ${keyNotes(p.description)} |\n`
  }

  // Column comments carry the reasoning worth keeping; they are the one place
  // this file can say WHY a column is the way it is.
  const noted = Object.entries(def.properties ?? {})
    .map(([col, p]) => [col, humanComment(p.description ?? '')])
    .filter(([, c]) => c.length > 0)
  if (noted.length) {
    out += `\n`
    for (const [col, c] of noted) out += `- \`${col}\` — ${c}\n`
  }
  out += `\n`
}

out += `---

## Callable functions (${rpcs.length})

Names only. What each one does, who may execute it, and whether it is
SECURITY DEFINER are all in the migration that created it.

${rpcs.map((r) => `- \`${r}()\``).join('\n')}
`

writeFileSync('supabase/SCHEMA-CURRENT.md', out)
console.log(`wrote supabase/SCHEMA-CURRENT.md — ${tables.length} tables, ${rpcs.length} functions`)
