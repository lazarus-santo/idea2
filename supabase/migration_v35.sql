-- migration_v35: add per-item coverage columns to prereads
--
-- Part of unifying museum AND fair coverage (exhibitions.coverage jsonb) into
-- the same prereads table galleries already use — see migration_v14's comment
-- for why coverage was originally split out ("targeted press coverage approach
-- for museums"); migration_v29 later reused the same exhibitions.coverage
-- column for fairs. All four columns below are nullable and galleries-
-- inapplicable — left null by generatePrereads()'s inserts:
--
--   artist_name        — which artist (of possibly several) this item is
--                        about. Carries CoverageItem.artist_name verbatim.
--   item_coverage_type — per-row kind: 'show_coverage' | 'artist_profile' |
--                        'artist_interview' | 'past_show' | 'general'
--                        (CoverageItem.coverage_type's value domain).
--   author             — CoverageItem.author verbatim. No workaround needed:
--                        an earlier draft of this migration folded author into
--                        summary as "By {author}" for lack of a real column;
--                        this replaces that with the real thing before it ships.
--   published_date      — CoverageItem.published_date verbatim. timestamptz, not
--                        date: every real value sampled from live coverage data
--                        is a full ISO-8601 datetime with a time component
--                        (Exa's native publishedDate format, e.g.
--                        "2025-12-10T10:00:00.000Z"), never a bare date — `date`
--                        would silently truncate that on every row.
--
-- Named item_coverage_type, not coverage_type, deliberately: exhibitions
-- already has a coverage_type column holding the Type A/B/C-small/C-large/D
-- classification tier — a completely different value domain. Reusing the same
-- name one join away from that column is exactly the kind of collision this
-- migration exists to avoid, not repeat.
ALTER TABLE prereads
  ADD COLUMN IF NOT EXISTS artist_name        text        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS item_coverage_type text        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS author             text        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS published_date     timestamptz DEFAULT NULL;

ALTER TABLE prereads
  DROP CONSTRAINT IF EXISTS chk_item_coverage_type;

ALTER TABLE prereads
  ADD CONSTRAINT chk_item_coverage_type
  CHECK (item_coverage_type IN ('show_coverage', 'artist_profile', 'artist_interview', 'past_show', 'general')
         OR item_coverage_type IS NULL);

-- exhibitions.coverage is deliberately NOT touched or dropped here. It stays in
-- place until the backfill script (scripts/backfill-coverage-to-prereads.mjs)
-- has been run and confirmed correct — see that script's own header.

-- ─── Verify ──────────────────────────────────────────────────────────────────
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'prereads' ORDER BY column_name;
--     -> expect artist_name (text), item_coverage_type (text), author (text),
--        and published_date (timestamp with time zone) alongside the existing
--        seven columns, all nullable
--
--   SELECT conname FROM pg_constraint WHERE conrelid = 'prereads'::regclass;
--     -> expect chk_item_coverage_type alongside the existing FK/PK constraints
