-- migration_v26.sql — RLS lockdown (strict: row + column restricted anon reads)
--
-- WHY
-- migration_v2.sql:164 says "Permissive: allow all operations (lock down before
-- public launch)" and then creates FOR ALL USING (true) WITH CHECK (true) on nine
-- tables. Later migrations (v18, v20, v21, schema_v5) copied the pattern under
-- *_service_all names. Those names imply the service role, but the policies are
-- untargeted, so they applied to `anon` — the key that ships to the browser.
--
-- Probed against the live database on 2026-07-31 with the anon key alone:
--   * SELECT returned 200 on all 16 tables.
--   * INSERT returned 23502 (NOT NULL violation) on 12 tables — the row was
--     rejected by a column constraint, not by RLS. RLS had already allowed it.
--   * agent1_discarded_items and agent1_missing_show_reports have no NOT NULL
--     columns, so the probe inserts returned 201 Created. Two rows were written
--     to production by an unauthenticated key (since deleted).
--   * Only exhibition_coverage and readings_tags refused (42501).
--
-- SAFETY
-- Nothing in the application reads or writes with the anon key. lib/supabase.ts
-- exports getSupabase() (anon) and getSupabaseAdmin() (service role); across
-- app/, lib/ and components/ there are 39 files using getSupabaseAdmin() and
-- zero call sites for getSupabase(). No client component imports lib/supabase.
-- Every page and API route already goes through the service role, which carries
-- BYPASSRLS and is unaffected by every policy below. Revoking anon access
-- therefore cannot break a live read.
--
-- The anon grants below exist for a future client-side read, and are scoped to
-- the columns the public surface actually renders — so if a feature ever does
-- reach for the anon key by mistake, it gets the public projection rather than
-- the whole row.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Drop every existing policy on the public tables.
--
-- Done by iterating pg_policies rather than by name: institutions and
-- exhibition_coverage were created directly in the SQL editor and their policy
-- names appear in no migration, and readings_tags behaves differently from what
-- schema_v5.sql declares. Dropping what is actually there is the only way to
-- land in a known state.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS on every public table.
--
-- RLS on with no policy for a role means that role is denied. This is the
-- deny-by-default floor; section 4 opens specific holes back up.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Revoke every grant from the browser-facing roles.
--
-- Two distinct jobs here:
--
--   a) Defense in depth on writes. Supabase grants anon and authenticated full
--      DML on public by default and lets RLS filter it. With the grant gone, a
--      future permissive policy added by hand in the SQL editor — the way the
--      current ones were — still cannot produce a write. Both layers have to
--      fail before data moves.
--
--   b) Making column-level SELECT possible at all. A table-wide SELECT grant
--      overrides any per-column grant, so the table-level privilege has to go
--      before section 4's column lists mean anything.
--
-- `authenticated` is included and is granted nothing back: admin access here is
-- a password in a query string, not a Supabase Auth session, so nothing
-- legitimate ever holds an authenticated JWT.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

-- service_role keeps everything; this is the key every API route uses.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Anon reads: row policy + column grant, per table.
--
-- Both halves are required. The policy decides which rows; the grant decides
-- which columns. Neither substitutes for the other — RLS has no column
-- dimension, and a column grant has no row dimension.
--
-- There is deliberately no INSERT/UPDATE/DELETE policy or grant for anon or
-- authenticated anywhere in this file. Writes go through the API routes, which
-- hold the service role.
--
-- Tables with nothing below are service-role-only:
--   agent_runs, agent1_fetch_logs, agent1_discarded_items,
--   agent1_missing_show_reports, exhibition_coverage, seed_books
-- Run history, per-URL fetch diagnostics, discarded scrape candidates,
-- unresolved missing-show reports, Agent 2 coverage bookkeeping, and the
-- seeding staging table. None of it is rendered anywhere public.
--
-- Column lists were derived by scanning the 37 files of the public surface
-- (public pages + public components + public API routes, excluding app/admin,
-- components/admin, app/api/admin, and the agent/cron/debug routes) for each
-- column name, then confirming each exclusion by hand.
-- ---------------------------------------------------------------------------

-- EXHIBITIONS — published rows only. The 36 pending rows are unreviewed
-- scraper output. Excluded columns: admin_notes, missing_fields, check_back_date,
-- updated_at, date_notes, detail_url, show_type, coverage_type — editorial
-- notes and scrape bookkeeping, none of which appear in the public surface.
CREATE POLICY "exhibitions_anon_read_published" ON exhibitions
  FOR SELECT TO anon
  USING (status = 'published');

GRANT SELECT (
  id, venue_id, show_title, start_date, end_date, description, press_release,
  image_url, status, created_at, address_override, address_override_neighborhood,
  override_latitude, override_longitude, coverage, preread_type, is_ongoing
) ON exhibitions TO anon;

-- PREREADS — visible only where the parent exhibition is public, or the join
-- leaks the existence and titles of unpublished shows. Every column is rendered
-- on the exhibition detail page.
CREATE POLICY "prereads_anon_read_published" ON prereads
  FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM exhibitions e
    WHERE e.id = prereads.exhibition_id AND e.status = 'published'
  ));

GRANT SELECT (
  id, exhibition_id, article_title, publication, article_url, thumbnail_url,
  summary, created_at
) ON prereads TO anon;

-- INSTITUTIONS — the public directory behind the map and venue pages. Inactive
-- rows are venues we have stopped scraping, not venues we are presenting.
CREATE POLICY "institutions_anon_read_active" ON institutions
  FOR SELECT TO anon
  USING (active = true);

GRANT SELECT (id, name, website, type, active, created_at) ON institutions TO anon;

-- VENUES — excluded columns: scrape_failed, scrape_failure_reason,
-- manual_entry_required, check_back_date. That is the scrape health of every
-- venue we track, which is operational detail, not directory data.
CREATE POLICY "venues_anon_read_active" ON venues
  FOR SELECT TO anon
  USING (active = true);

GRANT SELECT (
  id, name, exhibitions_url, address, neighborhood, latitude, longitude,
  active, created_at, institution_id, hours
) ON venues TO anon;

-- READINGS — wholly public at the row level; there is no status column and
-- every row is river-eligible.
--
-- NOTE ON THE SCORING COLUMNS. art_relevance_score, nyc_relevance_score,
-- top_story_candidate, major_artist and significant_announcement are granted
-- deliberately, against the first instinct to treat them as internal. The
-- Readings ranking is computed in the browser, not on the server:
-- components/ReadingsPage.tsx scoreReading() reads art_relevance_score,
-- significanceScore() reads significant_announcement / major_artist /
-- top_story_candidate, and compareReadingScores() uses nyc_relevance_score as
-- the tiebreaker. Withholding them would silently flatten the river ordering
-- for any future anon-key read.
--
-- Excluded: rss_summary (already stripped from /api/readings and /api/river
-- responses before they reach the browser — this matches that decision at the
-- database), plus tier and top_story_checked, which are curation bookkeeping.
-- publication_id is granted because the publications(name) join needs it.
CREATE POLICY "readings_anon_read" ON readings
  FOR SELECT TO anon USING (true);

GRANT SELECT (
  id, publication_id, author, headline, article_url, top_story, published_at,
  created_at, thumbnail_url, category, art_relevance_score, nyc_relevance_score,
  top_story_candidate, river_group, major_artist, significant_announcement
) ON readings TO anon;

-- READINGS_TAGS — the artist/gallery cross-links used by search.
CREATE POLICY "readings_tags_anon_read" ON readings_tags
  FOR SELECT TO anon USING (true);

GRANT SELECT (id, reading_id, entity_type, entity_id, exhibition_id, created_at)
  ON readings_tags TO anon;

-- PUBLICATIONS — only the name is ever rendered, as article attribution.
-- Excluded: domain, rss_url, tier, status, scrape_frequency, active — that is
-- the Agent 3 source list and its curation state. (PrereadCard derives its
-- favicon domain from the article URL, not from this column.)
CREATE POLICY "publications_anon_read" ON publications
  FOR SELECT TO anon USING (true);

GRANT SELECT (id, name) ON publications TO anon;

-- ARTISTS — only id and name are rendered as exhibition credits. bio, website
-- and instagram exist in the schema but appear nowhere in the public surface.
CREATE POLICY "artists_anon_read" ON artists
  FOR SELECT TO anon USING (true);

GRANT SELECT (id, name) ON artists TO anon;

-- EXHIBITION_ARTISTS — same join-visibility rule as prereads.
CREATE POLICY "exhibition_artists_anon_read_published" ON exhibition_artists
  FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM exhibitions e
    WHERE e.id = exhibition_artists.exhibition_id AND e.status = 'published'
  ));

GRANT SELECT (id, exhibition_id, artist_id) ON exhibition_artists TO anon;

-- EDITOR_PICKS — live picks only; a pending pick is an unpublished editorial
-- decision. All five columns are consumed by /api/editors-picks.
CREATE POLICY "editor_picks_anon_read_live" ON editor_picks
  FOR SELECT TO anon
  USING (status = 'live');

GRANT SELECT (id, pick_type, reference_id, status, created_at) ON editor_picks TO anon;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY
--
--   SELECT tablename, policyname, roles, cmd
--   FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename;
--
-- Expect 10 policies, all cmd = 'SELECT', all roles = {anon}. Any row with
-- cmd = 'ALL' or roles = {public} means something was recreated by hand.
--
--   SELECT table_name, string_agg(column_name, ', ' ORDER BY column_name)
--   FROM information_schema.column_privileges
--   WHERE grantee = 'anon' AND privilege_type = 'SELECT'
--   GROUP BY table_name ORDER BY table_name;
--
-- Expect exactly the ten column lists above and nothing else.
--
-- Note for anyone querying as anon afterwards: PostgREST's select=* asks for
-- every column and will now fail with 42501 on these tables. That is correct
-- behaviour — name the columns.
-- ---------------------------------------------------------------------------
