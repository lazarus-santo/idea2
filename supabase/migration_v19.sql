-- Migration v19: Agent 3 classification taxonomy overhaul
-- Revised category taxonomy, river_group toggle column, major_artist /
-- significant_announcement flags for Top Stories ranking.
-- Run in Supabase SQL Editor.

-- ─── readings: new category taxonomy ──────────────────────────────────────────
-- The constraint must be DROPPED (not swapped) before the remap runs: adding
-- the new constraint immediately would validate it against the still-old
-- 'news'/'conversation' rows below, which aren't in the new allowed list
-- either — that validation would fail before the remap ever gets to run.
-- So: drop constraint entirely (unconstrained) -> remap data -> add the new
-- constraint last, once every row already matches the new taxonomy.

ALTER TABLE readings DROP CONSTRAINT IF EXISTS chk_reading_category;
ALTER TABLE readings DROP CONSTRAINT IF EXISTS readings_category_check;

-- ─── Remap existing readings to the new taxonomy (best-effort) ───────────────
-- Old taxonomy: 'news' | 'opinion' | 'conversation'
-- New taxonomy adds breaking_news/art_market/show_review/show_roundup, which
-- 'news' can't be reliably split into after the fact — institutional_news is
-- the closest single bucket. 'opinion' and 'conversation' map directly.

UPDATE readings SET category = 'institutional_news' WHERE category = 'news';
UPDATE readings SET category = 'interview'           WHERE category = 'conversation';
-- category = 'opinion' already matches the new taxonomy — no change needed.

ALTER TABLE readings ADD CONSTRAINT chk_reading_category CHECK (category IS NULL OR category IN (
  'breaking_news',
  'institutional_news',
  'art_market',
  'interview',
  'opinion',
  'show_review',
  'show_roundup'
));

-- ─── readings: river group (frontend toggle grouping) ─────────────────────────

ALTER TABLE readings ADD COLUMN IF NOT EXISTS river_group text;

ALTER TABLE readings DROP CONSTRAINT IF EXISTS chk_reading_river_group;
ALTER TABLE readings ADD CONSTRAINT chk_reading_river_group CHECK (river_group IS NULL OR river_group IN (
  'news', 'art_market', 'people', 'opinion'
));

-- Backfill river_group for rows that already have a (remapped) category.
UPDATE readings SET river_group = CASE category
  WHEN 'breaking_news'       THEN 'news'
  WHEN 'institutional_news'  THEN 'news'
  WHEN 'art_market'          THEN 'art_market'
  WHEN 'interview'           THEN 'people'
  WHEN 'opinion'             THEN 'opinion'
  WHEN 'show_review'         THEN 'opinion'
  WHEN 'show_roundup'        THEN 'opinion'
  ELSE NULL
END
WHERE category IS NOT NULL;

-- ─── readings: artist/announcement significance flags ─────────────────────────
-- major_artist: primary subject artist has had a solo show at a MAJOR_MUSEUMS
--   institution (see lib/agent3-constants.ts).
-- significant_announcement: institutional_news covering a staff appointment/
--   departure or a solo exhibition/retrospective announcement. Needed to score
--   institutional_news correctly in the Top Stories ranking formula (0.85 vs 0.4)
--   once the article is sitting in the readings table with no live LLM context.

ALTER TABLE readings ADD COLUMN IF NOT EXISTS major_artist boolean DEFAULT false;
ALTER TABLE readings ADD COLUMN IF NOT EXISTS significant_announcement boolean DEFAULT false;
