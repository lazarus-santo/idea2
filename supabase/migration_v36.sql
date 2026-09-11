-- migration_v36: drop artists.website (dead column)
--
-- Confirmed before writing this migration:
--   - Zero writers anywhere in the codebase. The only two writes to `artists`
--     are `.insert({ name })` in scraper.ts (name only) and
--     `.update({ bio: ... })` (bio only) — website is never set by either.
--   - 0 of 852 rows have a non-null website (checked live against production).
--   - Excluded from the public API surface already — migration_v26's anon
--     grant on `artists` is `GRANT SELECT (id, name)`, so website was never
--     reachable outside the service role even while the column existed.
--   - No TypeScript interface models it — there is no `Artist` interface in
--     lib/types.ts; every `artists` select in the codebase is an inline,
--     ad hoc shape, and none of them include `website`.
--   - The new mechanical self-sourced check (searchArtistProfile /
--     searchShowReview, migration-less — pure application code) does not
--     depend on this column: it derives the artist's own domain from the
--     candidate URL and the artist's name string, never from a stored
--     website field.
--
ALTER TABLE artists
  DROP COLUMN IF EXISTS website;

-- ─── Verify ──────────────────────────────────────────────────────────────────
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'artists' ORDER BY column_name;
--     -> expect bio, created_at, id, instagram, name — no website
