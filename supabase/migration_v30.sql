-- Migration v30: remembered seed exclusions
--
-- The CSV import review table lets you remove a row before inserting, but that
-- removal only existed in React state — reloading the batch brought it straight
-- back, because the source of truth is a 664-row file that never changes. With
-- ~430 institutions to work through, re-rejecting the same ones on every visit
-- makes the tool unusable.
--
-- dedup_key holds the same normalized form the insert route and the import
-- preview already use for duplicate matching, so an exclusion survives the
-- gallery being spelled differently between Artguide and the added-majors list —
-- "Andrew Kreps" and "Andrew Kreps Gallery" share a key and are excluded
-- together. name is kept alongside it purely so the exclusions list is readable.
--
-- Exclusions are reversible by design: this is a hide, not a delete, and nothing
-- about the underlying CSV changes.

CREATE TABLE IF NOT EXISTS seed_exclusions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key  text NOT NULL UNIQUE,
  name       text NOT NULL,
  reason     text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seed_exclusions_key ON seed_exclusions(dedup_key);

-- Same posture as every other table after migration_v26: RLS on, and no policy
-- for anon or authenticated, so the table is reachable only by the service role
-- the API routes use. v26's ALTER DEFAULT PRIVILEGES should already withhold the
-- grants from new tables; the REVOKE makes that explicit rather than assumed.
ALTER TABLE seed_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON seed_exclusions FROM anon, authenticated;
GRANT ALL ON seed_exclusions TO service_role;

-- ─── Verify ──────────────────────────────────────────────────────────────────
--   SELECT policyname FROM pg_policies WHERE tablename = 'seed_exclusions';
--     -> expect zero rows (service-role only)
--
--   Probing /rest/v1/seed_exclusions with the anon key should return 42501.
