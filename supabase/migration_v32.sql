-- Migration v32: nonprofit and experimental institution types
--
-- The seed tool's dropdown and the /api/admin/seed/suggest prompt have offered
-- 'nonprofit' and 'experimental' for a while; the CHECK constraint never caught
-- up, so picking either failed at insert with a raw Postgres error surfaced into
-- the admin UI. EFA Studio Program was the first real one to hit it.
--
-- The constraint is still named galleries_type_check — the table was called
-- galleries before it became institutions. Renaming it is a separate change and
-- not worth bundling into one that has to be got right the first time.
--
-- Only additive: gallery (22 rows), museum (15) and fair (1) all stay valid, so
-- no existing row can be invalidated by this.

ALTER TABLE institutions
  DROP CONSTRAINT IF EXISTS galleries_type_check;

ALTER TABLE institutions
  ADD CONSTRAINT galleries_type_check
  CHECK (type IN ('gallery', 'museum', 'fair', 'nonprofit', 'experimental'));

COMMENT ON COLUMN institutions.type IS
  'gallery | museum | fair | nonprofit | experimental. nonprofit and experimental group under the "Other Spaces" tab on the public site, and are treated like galleries by Agent 1 (full prereads, not museum coverage_only).';

-- ─── Verify ──────────────────────────────────────────────────────────────────
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'galleries_type_check';
--     -> expect all five values
--
--   SELECT type, count(*) FROM institutions GROUP BY type;
--     -> gallery/museum/fair counts unchanged
