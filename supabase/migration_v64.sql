-- migration_v64: the Top Four lists
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project. Safe to re-run.
--
-- Phase 3 of 3, and the last of the logging feature. v62 logged exhibitions,
-- v63 logged the things people read; this lets someone say which four of each
-- mattered most. TWO lists per person, four slots each — not one combined list
-- of eight. Exhibitions and articles are different kinds of claim and the two
-- log tables are already split, so the Top Four follows the same seam.
--
-- ---------------------------------------------------------------------------
-- THE ELIGIBILITY RULE IS A FOREIGN KEY, NOT A CHECK — AND THAT IS THE WHOLE
-- DESIGN OF THIS FILE
--
-- The brief asks that an item can only be ranked if the person actually logged
-- it as seen/read, and that this be ENFORCED rather than hidden in the UI.
-- There are two halves to that, and they want different mechanisms:
--
--   DOES A LOG EXIST AT ALL?   A composite FOREIGN KEY into the log table's
--                              primary key. Not a trigger, not a CHECK — the
--                              database's own referential integrity.
--   IS IT AT 'seen' / 'read'?  A trigger, because a foreign key can point at a
--                              row but cannot have an opinion about its
--                              contents.
--
-- Making the first half a foreign key is what earns this file most of its
-- correctness for free, and it is worth being explicit about what falls out:
--
--   * A Top Four row CANNOT EXIST without its log row. Not "should not" —
--     cannot. There is no ordering of writes, no direct PostgREST call and no
--     future caller that can produce a ranked item nobody logged.
--   * DELETING the log removes it from the Top Four, through ON DELETE
--     CASCADE, with no code anywhere that knows to do it. Withdrawing a log
--     entirely (v62/v63's remove()) is the strongest form of "I take that
--     back", and a Top Four slot surviving it would be the loudest version of
--     the bug the brief is worried about.
--   * DELETING THE ACCOUNT still works in one step: profiles cascades to the
--     logs, which now cascade to here.
--   * REPOINTING a log at a different show is REFUSED while it is ranked,
--     because the foreign key has no ON UPDATE action. That is the right
--     answer — silently dragging somebody's favourite onto a different show
--     is worse than an error — and it costs the app nothing, since save()
--     always upserts the same key and Postgres does not fire referential
--     checks for a key that did not actually change.
--   * The exhibition/preread/reading itself needs no foreign key here at all.
--     The log row already vouches for the item — v62's FK for exhibitions,
--     v63's loggable trigger for the polymorphic pair — so this table points
--     at the LOG and inherits every guarantee the log already carries.
--
-- The only thing left for a trigger is the status, in section 3.
--
-- ---------------------------------------------------------------------------
-- THE DOWNGRADE PATH — WHY IT IS A DATABASE TRIGGER AND NOT MORE CLIENT CODE
--
-- The brief: a logged item that gets downgraded back to 'want_to_see' /
-- 'reading_list' (which already clears its rating, like and note) must also
-- leave the Top Four automatically, and it says to consider reusing the logic
-- that already does the clearing.
--
-- That logic was read, and it turns out not to be reusable, for a reason worth
-- recording. The clearing in v62/v63 is NOT in the database: there is no
-- trigger anywhere that nulls a rating. It is lib/exhibition-log-writes.ts and
-- lib/reading-log-writes.ts sending a COMPLETE row on every save, so a
-- downgrade carries explicit NULLs and the CHECK accepts it. The database's
-- part is only to REFUSE the combination.
--
-- So "extend the existing clearing logic" would mean adding a delete to both
-- client write modules and hoping every future caller remembers. That is
-- exactly the shape of rule this codebase keeps refusing to trust a client
-- with, and it would break in a way nobody would notice — a stale Top Four
-- slot looks fine until you click it.
--
-- Instead the rule lives where it cannot be skipped: AFTER UPDATE triggers on
-- exhibition_logs and reading_logs, in section 4. Any downgrade from anywhere
-- — the app, a script, the SQL editor, something written next year — drops the
-- item out of the Top Four in the same transaction. Neither client write
-- module is touched by this migration, which is the point.
--
-- WHY AFTER AND NOT BEFORE: the log row's new state is what decides this, and
-- an AFTER trigger cannot become the reason the downgrade itself fails. The
-- downgrade is what the person asked for; losing the slot is a consequence.
--
-- ---------------------------------------------------------------------------
-- REORDERING: THE LIST IS THE UNIT OF WRITE
--
-- The two constraints the brief asks for — one item per slot, one slot per
-- item — are what make a naive reorder fail. Swapping slots 1 and 2 as two
-- updates puts two rows in slot 1 in between, and the unique constraint
-- refuses it, correctly, halfway through.
--
-- The fix is not to weaken the constraint. It is to stop writing a Top Four
-- one row at a time. Sections 6 and 7 are functions that take the WHOLE list
-- and replace it inside one transaction: every row for that person is removed
-- FIRST, and only then is the new order placed. No intermediate state ever has
-- two rows in one slot, so a swap, a rotation, a replacement and a clear are
-- all the same operation and none of them can half-fail.
--
-- TWO ALTERNATIVES WERE CONSIDERED AND REJECTED, both worth recording because
-- they look tidier at first glance:
--
--   A DEFERRABLE UNIQUE CONSTRAINT would let the two-step swap through by
--   postponing the check to COMMIT. It fails at the wrong place: the error
--   arrives at the end of the request naming a constraint rather than an
--   operation, which through PostgREST is close to unreadable. And it would
--   only rescue a caller writing rows one at a time — the habit this file is
--   trying not to establish.
--
--   A TEMPORARY NEGATIVE POSITION OFFSET (move 1-4 to -1..-4, place the new
--   order, delete the leftovers) avoids the delete, but it requires
--   `CHECK (position BETWEEN 1 AND 4)` to also permit -4..-1, and a CHECK
--   cannot be deferred. Weakening the constraint that states the rule, in
--   order to work around the constraint that states the rule, is a bad trade.
--   Delete-then-place needs no such permission.
--
-- WHAT THE DELETE COSTS, AND WHY IT DOES NOT: created_at would reset on every
-- reorder, quietly turning "when I picked this" into "when I last touched the
-- list". So both functions snapshot the existing created_at values and carry
-- them back in, and an item that merely moved slots keeps the date it was
-- chosen. Only genuinely new entries get now().
--
-- ── AND THAT IS WHY THESE TABLES TAKE NO WRITE GRANTS ───────────────────────
--
-- A DEPARTURE FROM v62 AND v63, DELIBERATE AND WORTH JUSTIFYING. Both log
-- tables grant INSERT/UPDATE/DELETE to `authenticated` and let the browser
-- upsert straight to PostgREST under RLS, as follows and profile edits do.
-- These two tables grant SELECT only, and every write goes through the
-- functions in sections 6 and 7.
--
-- The difference is what the invariants are about. A log row is a complete
-- statement on its own — its CHECKs only ever look at that one row, so a row
-- is the honest unit of write. A Top Four's rules are about the LIST: four
-- slots, no duplicates, no two things in one place. Rules about a set cannot
-- be enforced one row at a time, and a client writing rows individually will
-- eventually write them in an order that is briefly illegal — which is the
-- exact failure the brief asks to design out.
--
-- So the grant follows the invariant. There is no INSERT, UPDATE or DELETE
-- privilege on these tables for anybody but service_role, which means a naive
-- per-row reorder is not merely discouraged, it is not expressible.
--
-- ---------------------------------------------------------------------------
-- A FROZEN PREREAD KEEPS ITS SLOT, AND ITS ORIGINAL CONTENT
--
-- The same rule as the reading log, and it needs no new machinery here — a
-- good sign the seam is in the right place:
--
--   IT KEEPS THE SLOT because eligibility is a foreign key into reading_logs
--   plus a status check, and freezing a preread does not touch the log row.
--   v61 blanks the PREREAD and points it at a replacement; the log — and
--   therefore the Top Four entry — is untouched and still at 'read'.
--
--   IT KEEPS THE CONTENT because profile_top_four_content() in section 9 does
--   not filter row_status or superseded_by, exactly as profile_reading_logs()
--   does not. It resolves to the row the person actually picked, and reports
--   `superseded` so the UI can say the piece has since been replaced.
--
-- Filtering frozen rows out here would make somebody's favourite article
-- silently vanish from their profile the moment Agent 2 repaired the show.
-- That is the loss v61 exists to prevent, one table further along.
--
-- ---------------------------------------------------------------------------
-- PRIVACY IS NOT RE-IMPLEMENTED HERE
--
-- A Top Four is part of a profile, so it is visible exactly as the rest of the
-- profile is: public to anyone, private to its owner and approved followers,
-- never across a block. Sections 8 and 9 ask public.can_view_profile() — v44's
-- function, widened by v48, the same one the follower lists, the feed and both
-- log functions ask. There is no privacy logic in this file that exists
-- anywhere else, and nothing here is allowed to grow any.
--
-- Unlike the logs there is no second, narrower gate: a Top Four slot carries
-- no note, so there is nothing for a comment_visibility to govern. The item's
-- rating and like are carried along, and those are already visible to anyone
-- who can see the log.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
--
-- No feed event type. v47's log is deliberately empty, and "updated their Top
-- Four" is now a PLAUSIBLE event — the brief says to note that and not build
-- it, so it is noted and not built. No notifications. Nothing in Agent 1, 2, 3
-- or 4 changes: this file reads exhibition, preread and reading rows and
-- writes none of them.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Top four exhibitions.
--
-- PRIMARY KEY (user_id, exhibition_id) is "the same show cannot be in two
-- slots". UNIQUE (user_id, position) is "a slot holds one show". The brief
-- asked for both, and between them they are what makes a reorder need the
-- strategy in section 6 rather than two casual updates.
--
-- THE FOREIGN KEY IS THE ELIGIBILITY RULE — see the header. It points at
-- exhibition_logs' primary key, which is (user_id, exhibition_id): the same
-- two columns in the same order, so this table's own primary key is also the
-- reference. A row here is therefore impossible unless that person logged that
-- show, and the CASCADE removes it if they ever un-log it.
--
-- There is deliberately NO foreign key to public.exhibitions. It would be
-- redundant — exhibition_logs already has one — and a second, weaker claim
-- about the same thing is how two claims end up disagreeing.
--
-- `position` is 1-4 and never 0: these are slots people talk about ("my number
-- one"), not array indexes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.top_four_exhibitions (
  user_id       uuid NOT NULL,
  exhibition_id uuid NOT NULL,
  position      smallint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, exhibition_id),

  CONSTRAINT top_four_exhibitions_position_range CHECK (position BETWEEN 1 AND 4),
  CONSTRAINT top_four_exhibitions_one_per_slot   UNIQUE (user_id, position),

  CONSTRAINT top_four_exhibitions_logged
    FOREIGN KEY (user_id, exhibition_id)
    REFERENCES public.exhibition_logs (user_id, exhibition_id)
    ON DELETE CASCADE
);

COMMENT ON TABLE public.top_four_exhibitions IS
  'Up to four exhibitions a person has picked out, positions 1-4. Eligibility is the FOREIGN KEY into exhibition_logs plus top_four_exhibitions_require_seen(): you can only rank a show you logged as seen, and un-logging or downgrading it removes it here automatically. Written ONLY through set_top_four_exhibitions(), which replaces the whole list — there are no row-level write grants. Other people read it through profile_top_four_exhibitions(), which applies profile privacy.';
COMMENT ON COLUMN public.top_four_exhibitions.created_at IS
  'When this show first entered the Top Four, PRESERVED ACROSS REORDERS — set_top_four_exhibitions() carries it back over the replace, so this stays the date it was picked rather than the last time the list was touched.';

-- ---------------------------------------------------------------------------
-- 2. Top four articles — prereads and readings together.
--
-- The same shape with the polymorphic key v63 established: (content_type,
-- content_id) identifies an item, because prereads and readings are different
-- tables with independent id spaces and an id alone is ambiguous.
--
-- WHERE v63 HAD TO GIVE SOMETHING UP, THIS DOES NOT. reading_logs could not
-- have a foreign key on content_id — there is nothing to point at — and stood
-- a trigger plus a join in its place. Here the reference is to the LOG, whose
-- primary key (user_id, content_type, content_id) is a perfectly ordinary
-- composite key. So the polymorphic item gets full referential integrity after
-- all, one level removed: this row cannot exist unless the log does, and the
-- log could not exist unless the item did.
--
-- content_type is NOT re-CHECKed against its two values here. The foreign key
-- already refuses anything reading_logs would not hold, and v63's CHECK is the
-- one place that list should live.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.top_four_content (
  user_id      uuid NOT NULL,
  content_type text NOT NULL,
  content_id   uuid NOT NULL,
  position     smallint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, content_type, content_id),

  CONSTRAINT top_four_content_position_range CHECK (position BETWEEN 1 AND 4),
  CONSTRAINT top_four_content_one_per_slot   UNIQUE (user_id, position),

  CONSTRAINT top_four_content_logged
    FOREIGN KEY (user_id, content_type, content_id)
    REFERENCES public.reading_logs (user_id, content_type, content_id)
    ON DELETE CASCADE
);

COMMENT ON TABLE public.top_four_content IS
  'Up to four articles a person has picked out, positions 1-4, across prereads and readings. Eligibility is the FOREIGN KEY into reading_logs plus top_four_content_require_read(): you can only rank something you logged as read. A FROZEN preread keeps its slot and still resolves to the content the person read — see profile_top_four_content(). Written ONLY through set_top_four_content().';
COMMENT ON COLUMN public.top_four_content.content_id IS
  'The prereads.id or readings.id, meaningful only alongside content_type. Unlike reading_logs.content_id this IS covered by a foreign key — not to the item, but to the log row that already vouches for it.';

-- ---------------------------------------------------------------------------
-- 3. The status half of eligibility.
--
-- The foreign key proves the person logged the item. It cannot say WHAT they
-- logged, and 'want_to_see' / 'reading_list' are the statuses that must not
-- reach a Top Four: ranking something you have not seen or read is the exact
-- claim the brief asks to reject rather than hide.
--
-- REJECTS, LIKE EVERY OTHER GATE IN THIS FEATURE. It does not skip the item
-- and save the rest of the list; the whole write fails, so the caller finds
-- out. v62 and v63 argued this at length for ratings and it holds here: a
-- silently dropped pick is a person believing they said something they did
-- not.
--
-- SECURITY DEFINER for a reason particular to these tables. The trigger reads
-- exhibition_logs / reading_logs, whose RLS is strictly first-person; running
-- as the caller it would see the caller's own rows and nothing else. That
-- happens to be all it ever needs, since a Top Four row is always the
-- caller's — but the functions in sections 6 and 7 are themselves SECURITY
-- DEFINER, so this would already be running as the owner in practice. Being
-- explicit means it behaves the same however it is reached.
--
-- NO SPECIAL HANDLING FOR THE BEFORE-INSERT / ON-CONFLICT ORDERING that
-- v63's reading_logs_loggable() needed, and it is worth saying why, because
-- the shape looks similar enough to copy by mistake. That function had to let
-- an EXISTING row through unchecked, so it mattered enormously which branch
-- it was on. This one asks a question that must be true in every branch, of
-- every row, always — an already-ranked item whose log is no longer 'seen' is
-- precisely the state section 4 exists to prevent. So it checks
-- unconditionally, which is correct on the insert path, the conflict path and
-- a direct update alike.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.top_four_exhibitions_require_seen()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.exhibition_logs l
     WHERE l.user_id       = NEW.user_id
       AND l.exhibition_id = NEW.exhibition_id
       AND l.status        = 'seen'
  ) THEN
    RAISE EXCEPTION 'top_four_not_seen'
      USING HINT = 'A show has to be marked as seen before it can go in your Top Four.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS top_four_exhibitions_seen_only ON public.top_four_exhibitions;
CREATE TRIGGER top_four_exhibitions_seen_only
  BEFORE INSERT OR UPDATE ON public.top_four_exhibitions
  FOR EACH ROW EXECUTE FUNCTION public.top_four_exhibitions_require_seen();

CREATE OR REPLACE FUNCTION public.top_four_content_require_read()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Deliberately says nothing about the preread's own row_status. A frozen
  -- preread is still something this person read, and its log row is still at
  -- 'read' — see the header. The only question here is what they said about it.
  IF NOT EXISTS (
    SELECT 1
      FROM public.reading_logs l
     WHERE l.user_id      = NEW.user_id
       AND l.content_type = NEW.content_type
       AND l.content_id   = NEW.content_id
       AND l.status       = 'read'
  ) THEN
    RAISE EXCEPTION 'top_four_not_read'
      USING HINT = 'An article has to be marked as read before it can go in your Top Four.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS top_four_content_read_only ON public.top_four_content;
CREATE TRIGGER top_four_content_read_only
  BEFORE INSERT OR UPDATE ON public.top_four_content
  FOR EACH ROW EXECUTE FUNCTION public.top_four_content_require_read();

-- ---------------------------------------------------------------------------
-- 4. Downgrading drops the item out of the Top Four.
--
-- The other side of section 3, and the half that has to be automatic. Marking
-- a show back to 'want_to_see' already clears the rating, the like and the
-- note; leaving it sitting at number two with nothing behind it would be the
-- same silent lie one field along.
--
-- ON THE LOG TABLES, NOT ON THESE — that is what makes it unskippable. The
-- trigger fires wherever the downgrade comes from, including a hand-written
-- UPDATE in the SQL editor, and neither client write module had to learn
-- anything.
--
-- SECURITY DEFINER IS LOAD-BEARING HERE, not habit. Section 5 gives
-- `authenticated` no DELETE on these tables at all, so a trigger running as
-- the caller would hit a permission error and take the person's perfectly
-- legitimate downgrade down with it. It runs as the owner instead. It deletes
-- only the row matching the log row that fired it, so the elevation buys it
-- nothing but the privilege it needs.
--
-- WHEN (...) rather than an IF inside: the condition is checked without
-- calling the function at all, so the overwhelmingly common write — saving a
-- rating on something still 'seen' — costs nothing.
--
-- THE DELETE CASE IS NOT HERE, because it does not need to be. Removing a log
-- row entirely takes the Top Four row with it through the foreign key's ON
-- DELETE CASCADE in sections 1 and 2. A second mechanism doing the same job
-- would be one more thing that could disagree.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exhibition_logs_drop_from_top_four()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.top_four_exhibitions
   WHERE user_id       = NEW.user_id
     AND exhibition_id = NEW.exhibition_id;

  -- AFTER FOR EACH ROW: the return value is ignored.
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS exhibition_logs_downgrade_drops_top_four ON public.exhibition_logs;
CREATE TRIGGER exhibition_logs_downgrade_drops_top_four
  AFTER UPDATE ON public.exhibition_logs
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM 'seen')
  EXECUTE FUNCTION public.exhibition_logs_drop_from_top_four();

CREATE OR REPLACE FUNCTION public.reading_logs_drop_from_top_four()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.top_four_content
   WHERE user_id      = NEW.user_id
     AND content_type = NEW.content_type
     AND content_id   = NEW.content_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS reading_logs_downgrade_drops_top_four ON public.reading_logs;
CREATE TRIGGER reading_logs_downgrade_drops_top_four
  AFTER UPDATE ON public.reading_logs
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM 'read')
  EXECUTE FUNCTION public.reading_logs_drop_from_top_four();

-- ---------------------------------------------------------------------------
-- 5. RLS and grants: read your own row, write nothing directly.
--
-- SELECT is first-person for the same reason the log tables' is: there is no
-- policy here that returns somebody else's row, and other people's lists are
-- reachable only through sections 8 and 9, which ask can_view_profile(). The
-- own-row read exists so the editor can load what is currently in the list
-- without going through a function that would answer about privacy it already
-- knows the answer to.
--
-- THERE ARE NO WRITE POLICIES AND NO WRITE GRANTS. See the header: the unit of
-- write is the list, so the only way in is set_top_four_exhibitions() and
-- set_top_four_content(). A policy without a grant would be decoration; a
-- grant without a policy would be a hole. There is neither.
--
-- No anon policy: a signed-out visitor has no Top Four of their own.
--
-- ── DO NOT ADD `FORCE ROW LEVEL SECURITY` TO THESE TWO TABLES ───────────────
--
-- It is not set, and that is load-bearing rather than an oversight. ENABLE
-- leaves the table's OWNER exempt from its policies, which is what lets the
-- SECURITY DEFINER functions in sections 6 and 7 — and the downgrade triggers
-- in section 4 — write rows that no policy here permits. FORCE would subject
-- the owner to the policies too, and since there are deliberately no write
-- policies, every Top Four write in the product would begin failing at once.
-- A future migration tightening this "for consistency" would break the feature
-- completely, which is why it is written down here rather than left to be
-- rediscovered.
-- ---------------------------------------------------------------------------
ALTER TABLE public.top_four_exhibitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.top_four_content     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS top_four_exhibitions_read_own ON public.top_four_exhibitions;
CREATE POLICY top_four_exhibitions_read_own ON public.top_four_exhibitions
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS top_four_content_read_own ON public.top_four_content;
CREATE POLICY top_four_content_read_own ON public.top_four_content
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

GRANT SELECT (user_id, exhibition_id, position, created_at)
  ON public.top_four_exhibitions TO authenticated;
GRANT SELECT (user_id, content_type, content_id, position, created_at)
  ON public.top_four_content TO authenticated;

GRANT ALL ON public.top_four_exhibitions TO service_role;
GRANT ALL ON public.top_four_content     TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Set the whole exhibition Top Four.
--
-- Takes the list IN ORDER: the first id is slot 1, the second slot 2, and so
-- on. Fewer than four is fine and is how a slot is left empty; an empty array
-- clears the list. There is no add(), no remove() and no move() — every one of
-- those is this function called with a different list, which is why a reorder
-- cannot half-happen.
--
-- SECURITY DEFINER, and it takes NO user_id. The list is always the caller's,
-- read from auth.uid() and never from an argument, so there is no parameter
-- anybody could point at somebody else's profile. That is the whole of the
-- authorisation story, and it is why the elevation is safe: this function can
-- write these tables, and it can only ever write one person's rows — the
-- person calling it.
--
-- The eligibility triggers in section 3 still fire inside it. SECURITY DEFINER
-- raises the privilege, not the rules.
--
-- ORDER OF OPERATIONS, and each step is there for a reason:
--   1. validate    length, duplicates, and that every id is really an id.
--      Before anything is written, so a bad list changes nothing.
--   2. snapshot    the created_at of what is already in the list, keyed by
--      item, so a reorder does not restamp the dates.
--   3. delete      all four slots at once. This is what makes the constraints
--      unfightable: nothing is in slots 1-4 when the new order is placed.
--   4. insert      the new order, with the old dates where the item stayed.
--
-- It is one function body and therefore one transaction. A failure at step 4 —
-- an item that is no longer 'seen', say — rolls back the delete at step 3, so
-- a refused write leaves the previous Top Four exactly as it was rather than
-- emptying it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_top_four_exhibitions(p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me    uuid   := (SELECT auth.uid());
  ids   uuid[] := coalesce(p_ids, ARRAY[]::uuid[]);
  n     integer := coalesce(array_length(ids, 1), 0);
  prior jsonb;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_signed_in'
      USING HINT = 'Sign in to change your Top Four.';
  END IF;

  IF n > 4 THEN
    RAISE EXCEPTION 'top_four_too_many'
      USING HINT = 'A Top Four holds four shows at most.';
  END IF;

  -- A NULL in the middle of the array would become a NOT NULL violation three
  -- statements later, by which point the list has already been deleted and the
  -- error names a column instead of the mistake.
  IF EXISTS (SELECT 1 FROM unnest(ids) AS u(id) WHERE u.id IS NULL) THEN
    RAISE EXCEPTION 'top_four_bad_input'
      USING HINT = 'That Top Four contains an empty slot in the middle of the list.';
  END IF;

  -- The primary key would catch this, but as a 23505 naming an index. The same
  -- show twice is an ordinary thing for a UI to get wrong, so it gets its own
  -- answer.
  IF n <> (SELECT count(DISTINCT u.id) FROM unnest(ids) AS u(id)) THEN
    RAISE EXCEPTION 'top_four_duplicate'
      USING HINT = 'The same show cannot take two slots.';
  END IF;

  -- Step 2: what is already there, so a move keeps its date. jsonb rather than
  -- a temp table because this is at most four rows and a temp table inside a
  -- SECURITY DEFINER function is a shared name waiting to collide.
  SELECT coalesce(jsonb_object_agg(t.exhibition_id::text, t.created_at), '{}'::jsonb)
    INTO prior
    FROM public.top_four_exhibitions t
   WHERE t.user_id = me;

  -- Step 3: vacate every slot. See the header for why this beats a swap.
  DELETE FROM public.top_four_exhibitions t WHERE t.user_id = me;

  -- Step 4: place the new order. WITH ORDINALITY is the position — the list's
  -- order IS the ranking, which is what makes reordering a matter of sending
  -- the same ids differently arranged.
  INSERT INTO public.top_four_exhibitions (user_id, exhibition_id, position, created_at)
  SELECT
    me,
    x.id,
    x.ord::smallint,
    coalesce((prior ->> x.id::text)::timestamptz, now())
  FROM unnest(ids) WITH ORDINALITY AS x(id, ord);
END;
$$;

COMMENT ON FUNCTION public.set_top_four_exhibitions(uuid[]) IS
  'Replace the caller''s exhibition Top Four with this list, in order: element 1 is slot 1. Fewer than four leaves later slots empty; an empty array clears it. Always the CALLER''s list — it reads auth.uid() and takes no user_id. Every id must already be logged as seen or the whole write is refused. Reordering is this function with the same ids in a different order, which is why no two-step swap can violate the one-per-slot constraint.';

-- ---------------------------------------------------------------------------
-- 7. Set the whole article Top Four.
--
-- The same function for the polymorphic list, and the reason it takes jsonb
-- rather than arrays is worth a line: an article is identified by a PAIR, and
-- two parallel arrays (types[], ids[]) can arrive at different lengths or
-- silently misaligned by one. A single array of objects cannot come apart —
-- `[{"type":"preread","id":"..."}, ...]` — so the shape enforces what a
-- length check would otherwise have to.
--
-- Everything else — validation first, snapshot, vacate, place — is section 6.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_top_four_content(p_items jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me    uuid  := (SELECT auth.uid());
  items jsonb := coalesce(p_items, '[]'::jsonb);
  n     integer;
  prior jsonb;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_signed_in'
      USING HINT = 'Sign in to change your Top Four.';
  END IF;

  IF jsonb_typeof(items) <> 'array' THEN
    RAISE EXCEPTION 'top_four_bad_input'
      USING HINT = 'A Top Four is a list of {type, id} entries.';
  END IF;

  n := jsonb_array_length(items);

  IF n > 4 THEN
    RAISE EXCEPTION 'top_four_too_many'
      USING HINT = 'A Top Four holds four articles at most.';
  END IF;

  -- Both halves of the key, on every entry. An entry missing one would cast to
  -- NULL and fail later as a NOT NULL violation, after the delete.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(items) AS e(item)
     WHERE e.item ->> 'type' IS NULL OR e.item ->> 'id' IS NULL
  ) THEN
    RAISE EXCEPTION 'top_four_bad_input'
      USING HINT = 'Every Top Four entry needs both a type and an id.';
  END IF;

  -- DISTINCT ON THE PAIR, not on the id. Two different articles can share an
  -- id across the two tables — that is the whole reason content_type exists —
  -- so de-duplicating by id alone would reject a legitimate list.
  -- ROW(...) spelled out rather than the bare (a, b) form: inside an aggregate's
  -- argument list a parenthesised pair is ambiguous with a two-argument call,
  -- and count() takes one argument, so the implicit form is a syntax error
  -- waiting to happen.
  IF n <> (
    SELECT count(DISTINCT ROW(e.item ->> 'type', (e.item ->> 'id')::uuid))
      FROM jsonb_array_elements(items) AS e(item)
  ) THEN
    RAISE EXCEPTION 'top_four_duplicate'
      USING HINT = 'The same article cannot take two slots.';
  END IF;

  -- Keyed by 'type:id' with the id put through uuid and back, so a caller that
  -- sends an upper-case or otherwise non-canonical uuid still matches its own
  -- existing row and keeps its date.
  SELECT coalesce(
           jsonb_object_agg(t.content_type || ':' || t.content_id::text, t.created_at),
           '{}'::jsonb
         )
    INTO prior
    FROM public.top_four_content t
   WHERE t.user_id = me;

  DELETE FROM public.top_four_content t WHERE t.user_id = me;

  INSERT INTO public.top_four_content (user_id, content_type, content_id, position, created_at)
  SELECT
    me,
    x.item ->> 'type',
    (x.item ->> 'id')::uuid,
    x.ord::smallint,
    coalesce(
      (prior ->> ((x.item ->> 'type') || ':' || ((x.item ->> 'id')::uuid)::text))::timestamptz,
      now()
    )
  FROM jsonb_array_elements(items) WITH ORDINALITY AS x(item, ord);
END;
$$;

COMMENT ON FUNCTION public.set_top_four_content(jsonb) IS
  'Replace the caller''s article Top Four with this list, in order: [{"type":"preread"|"reading","id":"<uuid>"}, ...], element 1 is slot 1. An empty array clears it. Always the CALLER''s list — it reads auth.uid() and takes no user_id. Every entry must already be logged as read or the whole write is refused. jsonb rather than parallel arrays so the type and the id cannot come apart.';

-- EXECUTE is granted to PUBLIC by default, which on a SECURITY DEFINER
-- function is worth undoing explicitly rather than relying on the auth.uid()
-- check to turn anon away at the door. `anon` is not granted either: a
-- signed-out visitor has no Top Four to set, and the refusal should be "you
-- cannot call this", not a raised exception from inside it.
REVOKE ALL ON FUNCTION public.set_top_four_exhibitions(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_top_four_content(jsonb)      FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_top_four_exhibitions(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_top_four_content(jsonb)      TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Somebody's exhibition Top Four — the only way to read one.
--
-- The counterpart of profile_exhibition_logs(), and gated identically:
--
--   can_view_profile(profile_id)  empty for a visitor who may not see this
--                                 person — private and not an approved
--                                 follower, or a block in either direction.
--                                 THE SAME FUNCTION, asked once for the query.
--   e.status = 'published'        an unpublished show appears on nobody's
--                                 profile, applied on read as well as on write.
--
-- There is no third gate, because there is no note here for one to govern. The
-- rating and like ride along from the log: anyone allowed to see the profile
-- can already see them in the log itself, so withholding them here would only
-- make the same person's two lists disagree.
--
-- Ordered by slot, obviously — this is the one list in the product where the
-- order is the content.
-- ---------------------------------------------------------------------------
-- "position" IS QUOTED HERE AND NOWHERE ELSE, WHICH LOOKS INCONSISTENT AND IS
-- NOT. `position` is a col_name_keyword in Postgres: legal as a column name —
-- which is why sections 1 and 2 spell it bare — but NOT legal as a function
-- parameter name, and the columns of a RETURNS TABLE are parameters. Unquoted
-- here, this file fails to parse on the very first paste. Quoting makes it an
-- ordinary identifier, so the app still sees one name for one thing.
CREATE OR REPLACE FUNCTION public.profile_top_four_exhibitions(profile_id uuid)
RETURNS TABLE (
  "position"    smallint,
  exhibition_id uuid,
  picked_at     timestamptz,
  rating        smallint,
  liked         boolean,
  show_title    text,
  start_date    date,
  end_date      date,
  image_url     text,
  venue_name    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    t.position,
    t.exhibition_id,
    t.created_at,
    l.rating,
    l.liked,
    e.show_title,
    e.start_date,
    e.end_date,
    e.image_url,
    coalesce(i.name, v.name)
  FROM public.top_four_exhibitions t
  JOIN public.exhibition_logs l
    ON l.user_id = t.user_id AND l.exhibition_id = t.exhibition_id
  JOIN public.exhibitions e ON e.id = t.exhibition_id
  LEFT JOIN public.venues       v ON v.id = e.venue_id
  LEFT JOIN public.institutions i ON i.id = v.institution_id
  WHERE t.user_id = profile_id
    AND e.status = 'published'
    AND public.can_view_profile(profile_id)
  ORDER BY t.position;
$$;

COMMENT ON FUNCTION public.profile_top_four_exhibitions(uuid) IS
  'A person''s four favourite exhibitions, as a given visitor is allowed to see them. Empty unless can_view_profile() says yes — the same gate as their log, so a private profile''s Top Four is invisible to a non-approved follower. Returns fewer than four rows when fewer are set; the empty slots are the caller''s to draw. MUST be called with the visitor''s session: can_view_profile() reads auth.uid().';

-- ---------------------------------------------------------------------------
-- 9. Somebody's article Top Four.
--
-- Two branches over two tables, as profile_reading_logs() has, and the preread
-- branch carries the rule this phase had to inherit:
--
--   NO row_status OR superseded_by FILTER. A frozen preread is exactly the
--   article the person picked. v61 keeps it byte-for-byte for this purpose,
--   and hiding it here would empty a slot on somebody's profile the moment
--   Agent 2 repaired an unrelated show. `superseded` is returned so the UI can
--   say the piece has since been replaced — honest, and not alarming.
--
-- The EXHIBITION's status is still filtered, because that is a privacy rule
-- rather than a content-lifecycle one: an unpublished show is not something a
-- profile may disclose, whatever is written about it.
-- ---------------------------------------------------------------------------
-- "position" quoted for the reason given above section 8.
CREATE OR REPLACE FUNCTION public.profile_top_four_content(profile_id uuid)
RETURNS TABLE (
  "position"    smallint,
  content_type  text,
  content_id    uuid,
  picked_at     timestamptz,
  rating        smallint,
  liked         boolean,
  title         text,
  publication   text,
  article_url   text,
  thumbnail_url text,
  author        text,
  published_at  timestamptz,
  exhibition_id uuid,
  show_title    text,
  superseded    boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Prereads. Frozen rows included on purpose — see the note above.
  SELECT
    t.position,
    t.content_type,
    t.content_id,
    t.created_at,
    l.rating,
    l.liked,
    p.article_title,
    p.publication,
    p.article_url,
    p.thumbnail_url,
    p.author,
    p.published_date,
    e.id,
    e.show_title,
    (p.superseded_by IS NOT NULL)
  FROM public.top_four_content t
  JOIN public.reading_logs l
    ON l.user_id = t.user_id
   AND l.content_type = t.content_type
   AND l.content_id = t.content_id
  JOIN public.prereads    p ON p.id = t.content_id
  JOIN public.exhibitions e ON e.id = p.exhibition_id
  WHERE t.user_id = profile_id
    AND t.content_type = 'preread'
    AND e.status = 'published'
    AND public.can_view_profile(profile_id)

  UNION ALL

  -- Readings. Every row is public (v26), so there is no second gate; the
  -- publications join is only for the name shown as attribution.
  SELECT
    t.position,
    t.content_type,
    t.content_id,
    t.created_at,
    l.rating,
    l.liked,
    r.headline,
    pub.name,
    r.article_url,
    r.thumbnail_url,
    r.author,
    r.published_at,
    NULL::uuid,
    NULL::text,
    false
  FROM public.top_four_content t
  JOIN public.reading_logs l
    ON l.user_id = t.user_id
   AND l.content_type = t.content_type
   AND l.content_id = t.content_id
  JOIN public.readings r ON r.id = t.content_id
  LEFT JOIN public.publications pub ON pub.id = r.publication_id
  WHERE t.user_id = profile_id
    AND t.content_type = 'reading'
    AND public.can_view_profile(profile_id)

  ORDER BY 1;
$$;

COMMENT ON FUNCTION public.profile_top_four_content(uuid) IS
  'A person''s four favourite articles — prereads and readings together — as a given visitor is allowed to see them. Empty unless can_view_profile() says yes. A FROZEN preread keeps its slot and renders the content the person actually read (superseded = true): hiding it would undo migration_v61. MUST be called with the visitor''s session.';

-- anon is granted both, deliberately and for the reason v62 and v63 give: a
-- public profile's Top Four is public, exactly as its log, follower list and
-- events already are. With no session auth.uid() is NULL, so can_view_profile()
-- answers true for public profiles only and a private person's list is
-- unreachable.
GRANT EXECUTE ON FUNCTION public.profile_top_four_exhibitions(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profile_top_four_content(uuid)     TO anon, authenticated;

COMMIT;

-- PostgREST caches the schema; new tables and functions are invisible over the
-- REST API until it reloads. Supabase normally fires this itself on DDL.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- DID IT LAND? Read what this prints. Every column should say true.
--
-- `logged_fk_present` is the one to look at on a re-run: the foreign key into
-- the log tables IS the eligibility rule, and without it the status triggers
-- would still pass while a Top Four row could point at a show nobody logged.
--
-- `no_write_grants` is the other: it proves these tables are still write-only
-- through the set functions. A future migration that hands `authenticated` an
-- INSERT here would re-open the one-row-at-a-time reorder this file exists to
-- make impossible, and this is where that would show up.
-- ---------------------------------------------------------------------------
SELECT
  to_regclass('public.top_four_exhibitions') IS NOT NULL          AS exhibitions_table_exists,
  to_regclass('public.top_four_content') IS NOT NULL              AS content_table_exists,
  to_regproc('public.set_top_four_exhibitions') IS NOT NULL       AS set_exhibitions_exists,
  to_regproc('public.set_top_four_content') IS NOT NULL           AS set_content_exists,
  to_regproc('public.profile_top_four_exhibitions') IS NOT NULL   AS read_exhibitions_exists,
  to_regproc('public.profile_top_four_content') IS NOT NULL       AS read_content_exists,
  (SELECT count(*) = 2
     FROM pg_constraint
    WHERE contype = 'f'
      AND conname IN ('top_four_exhibitions_logged', 'top_four_content_logged'))
                                                                  AS logged_fk_present,
  (SELECT count(*) = 2
     FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN ('exhibition_logs_downgrade_drops_top_four',
                     'reading_logs_downgrade_drops_top_four'))
                                                                  AS downgrade_triggers_present,
  (SELECT count(*) = 0
     FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('top_four_exhibitions', 'top_four_content')
      AND grantee = 'authenticated'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE'))       AS no_write_grants;

-- ---------------------------------------------------------------------------
-- VERIFY
--
-- scripts/test-top-four.mjs proves all of this against the live database with
-- real sessions. Run it after applying this file:
--
--   node --env-file=.env.local --import ./scripts/ts-resolve.mjs \
--     scripts/test-top-four.mjs
--
-- It must be a script and not a query in this editor, because the editor runs
-- as postgres and bypasses every policy and grant above — including the
-- missing write grants, which are half the design.
-- ---------------------------------------------------------------------------
