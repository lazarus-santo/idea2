-- migration_v68: Top Stories rebuilt as story groups
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project. Safe to re-run.
--
-- APPLY IT TOGETHER WITH THE CODE THAT READS IT. Section 5 drops
-- readings.top_story and readings.top_story_candidate. Code from before this
-- change writes both on every Agent 3 insert, and the Readings page reads
-- top_story. Agent 3's crons are paused (vercel.json "crons": []), so the only
-- exposure is a manual Agent 3 run between the migration and the deploy.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGED
--
-- A Top Story used to be a single reading flagged at insert time: a category
-- rule (deriveTopStoryCandidate) AND a tier-1 outlet AND art_relevance_score
-- >= 0.8. 204 of 309 readings qualified — gossip columns got in, and a death
-- reported by four non-tier-1 outlets could not.
--
-- A Top Story is now a GROUP: three or more different outlets covering the
-- same event within three days of each other. lib/story-groups.ts builds the
-- groups as readings are saved: embed the headline + summary (Voyage), compare
-- against readings published within three days, ask Haiku to confirm the
-- close ones. Every comparison is logged so the threshold can be tuned on real
-- data rather than guessed.
--
-- ---------------------------------------------------------------------------
-- ACCESS
--
-- None of the three new tables is readable by anon or authenticated. RLS is on
-- with no policies, and the grants below are to service_role only. The page
-- reads story groups through /api/top-stories, which uses the service-role
-- client, the same way /api/readings and /api/river already do.
--
-- readings.story_group_id, story_checked_at and story_is_digest are NOT added to
-- migration_v26's column-level anon grant on readings, so they are not
-- publicly readable either. That is deliberate and costs nothing: nothing in
-- the browser reads readings directly.

-- ---------------------------------------------------------------------------
-- 1. story_groups — one row per cluster, including two-outlet clusters that
--    are not (yet) Top Stories.

CREATE TABLE IF NOT EXISTS public.story_groups (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL until the group first reaches three outlets, then fixed for good
  -- (section 4). Fixing it any earlier could lock in a non-tier-1 lead a
  -- moment before a tier-1 outlet joins.
  lead_reading_id     uuid        REFERENCES public.readings(id),
  lead_set_at         timestamptz,
  -- Earliest / latest published date among the members. The group leaves the
  -- page seven days after first_published_at.
  first_published_at  timestamptz NOT NULL,
  last_published_at   timestamptz NOT NULL,
  -- Distinct publications among the non-digest members. Three or more = a Top Story.
  outlet_count        integer     NOT NULL DEFAULT 0 CHECK (outlet_count >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((lead_reading_id IS NULL) = (lead_set_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_story_groups_visible
  ON public.story_groups (first_published_at DESC)
  WHERE lead_reading_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. readings — which group a reading belongs to, and whether grouping has
--    run for it yet.
--
-- story_checked_at stays NULL when the embedding or the Haiku call fails, so
-- the next Agent 3 run retries the reading instead of it being silently
-- ungrouped for good.
--
-- story_is_digest is Haiku's answer, from the same call that confirms matches,
-- to "is this a round-up of unrelated items?" ("Morning Links", "... and Other
-- Art World Matters"). A digest can sit in a group but never counts as an
-- outlet, never leads and never appears on the "More:" line. NULL means no
-- Haiku call was needed for it — nothing was close enough — and is treated as
-- not a digest.

ALTER TABLE public.readings
  ADD COLUMN IF NOT EXISTS story_group_id   uuid REFERENCES public.story_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS story_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS story_is_digest  boolean;

CREATE INDEX IF NOT EXISTS idx_readings_story_group ON public.readings (story_group_id)
  WHERE story_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_readings_story_unchecked ON public.readings (published_at)
  WHERE story_checked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. reading_embeddings — its own table, not a column on readings.
--
-- /api/readings and /api/river both select('*') from readings. A 1024-number
-- embedding on every row would add ~10 KB per article to every Readings page
-- load, for data the browser never uses. Kept apart, nothing that already
-- reads readings changes.
--
-- A plain real[] rather than pgvector: each new reading is compared against
-- ~60-100 readings from a six-day window, so the comparison is done in
-- lib/story-groups.ts. No extension to enable, and no database function that
-- would need keeping off the REST API.

CREATE TABLE IF NOT EXISTS public.reading_embeddings (
  reading_id  uuid        PRIMARY KEY REFERENCES public.readings(id) ON DELETE CASCADE,
  model       text        NOT NULL,
  embedding   real[]      NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 4. story_match_log — every comparison made, above and below the threshold.
--
-- One row per (new reading, candidate reading) pair in the window. The rows
-- below the threshold are the point: without them there is no way to tell
-- later whether the threshold is dropping real matches.

CREATE TABLE IF NOT EXISTS public.story_match_log (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_id            uuid        NOT NULL REFERENCES public.readings(id) ON DELETE CASCADE,
  candidate_reading_id  uuid        NOT NULL REFERENCES public.readings(id) ON DELETE CASCADE,
  -- The candidate's group at the moment of comparison; NULL if it had none.
  candidate_group_id    uuid        REFERENCES public.story_groups(id) ON DELETE SET NULL,
  similarity            real        NOT NULL,
  threshold_used        real        NOT NULL,
  sent_to_llm           boolean     NOT NULL DEFAULT false,
  -- NULL when not sent to the LLM.
  llm_same_event        boolean,
  llm_reason            text,
  embedding_model       text        NOT NULL,
  llm_model             text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_story_match_log_reading ON public.story_match_log (reading_id);
CREATE INDEX IF NOT EXISTS idx_story_match_log_sim     ON public.story_match_log (similarity DESC);

-- ---------------------------------------------------------------------------
-- 5. The lead never changes once set.
--
-- The application sets it once, but this is the rule that guarantees it. A
-- BEFORE UPDATE trigger rather than a CHECK because the rule is about the
-- transition, not the row.

CREATE OR REPLACE FUNCTION public.story_groups_freeze_lead()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.lead_reading_id IS NOT NULL
     AND NEW.lead_reading_id IS DISTINCT FROM OLD.lead_reading_id THEN
    RAISE EXCEPTION 'story_groups.lead_reading_id is fixed once set (group %)', OLD.id;
  END IF;
  IF OLD.lead_set_at IS NOT NULL
     AND NEW.lead_set_at IS DISTINCT FROM OLD.lead_set_at THEN
    NEW.lead_set_at := OLD.lead_set_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS story_groups_freeze_lead ON public.story_groups;
CREATE TRIGGER story_groups_freeze_lead
  BEFORE UPDATE ON public.story_groups
  FOR EACH ROW EXECUTE FUNCTION public.story_groups_freeze_lead();

REVOKE ALL ON FUNCTION public.story_groups_freeze_lead() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 6. Access: service_role only.

ALTER TABLE public.story_groups       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reading_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.story_match_log    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.story_groups       FROM anon, authenticated;
REVOKE ALL ON public.reading_embeddings FROM anon, authenticated;
REVOKE ALL ON public.story_match_log    FROM anon, authenticated;

GRANT ALL ON public.story_groups       TO service_role;
GRANT ALL ON public.reading_embeddings TO service_role;
GRANT ALL ON public.story_match_log    TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Retire the old flag.
--
-- After this change nothing reads or writes either column: the page reads
-- story groups, the admin "Top Stories" count reads story groups, and Agent 3
-- no longer computes a per-reading candidate. Dropping them also drops them
-- from migration_v26's anon column grant.
--
-- art_relevance_score is KEPT. It no longer decides anything, but Haiku
-- produces it in the same classification call at no extra cost.
--
-- top_story_checked (migration_v8) is untouched: it was bookkeeping for the
-- Exa pass removed in 9c58934 and has been dead since, but it is outside this
-- change.

DROP INDEX IF EXISTS public.idx_readings_top_story;
ALTER TABLE public.readings
  DROP COLUMN IF EXISTS top_story,
  DROP COLUMN IF EXISTS top_story_candidate;
