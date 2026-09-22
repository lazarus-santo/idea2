-- migration_v69: readings_rejected — articles Agent 3 has already turned down
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
--
-- Apply BEFORE deploying the lib/readings-curator.ts change that reads it.
-- The curator survives the table being missing — it records a run error and
-- behaves as it did before (re-checking every rejection) — but it will not
-- remember anything until this exists.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- Agent 3 only ever saves articles it accepts. An article Haiku turns down
-- leaves no trace, so the next run finds it in the feed again, cannot tell it
-- apart from a new one, and pays Haiku to turn it down again — every run,
-- until the article is older than the 7-day window. On quiet days the hourly
-- run saw ~25 "new" articles and saved 1: the other ~24 were the same
-- rejections, re-sent.
--
-- One row per article URL Agent 3 has decided not to save:
--   not_relevant  the relevance check (Stage 2) said it is not about art
--   nyc_roundup   a show_roundup with no NYC angle (the Part 6 hard filter)
--
-- Only articles a check actually RULED ON are written. A relevance batch that
-- errors or comes back unparseable writes nothing, so its articles are simply
-- tried again next run — a failed call is never mistaken for a "no".
--
-- Nothing reads this table except Agent 3 (service role). RLS is on with no
-- policies, so no one else can read or write it through the API.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.readings_rejected (
  article_url     text        PRIMARY KEY,
  publication_id  uuid        REFERENCES public.publications(id) ON DELETE SET NULL,
  headline        text,
  reason          text        NOT NULL CHECK (reason IN ('not_relevant', 'nyc_roundup')),
  rejected_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.readings_rejected IS
  'Article URLs Agent 3 has already turned down, so later runs skip them instead of re-sending them to Haiku. Written only by lib/readings-curator.ts (service role), and only for articles a check actually ruled on — a failed call writes nothing. See migration_v69.';

ALTER TABLE public.readings_rejected ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.readings_rejected FROM anon, authenticated;
