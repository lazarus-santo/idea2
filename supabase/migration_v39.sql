-- migration_v39: show-based exhibition locations
--
-- Agent 1 now resolves where each show physically is — from an address on the
-- listing page or the show's own page — instead of assuming the venue's
-- address. The venue address becomes the fallback, used only when no address
-- is found anywhere (see lib/show-location.ts).
--
-- SHAPE: one standardized text column per location, not structured parts.
--   "535 West 22nd Street, 6th Floor, Manhattan, New York 10011"
--   (street, optional floor/suite, borough, "New York" + zip)
-- The format is produced by exactly one function (formatStandardAddress in
-- lib/address-normalize.ts), so a single column cannot drift out of shape; every
-- consumer — the exhibition page, the map, geocoding — wants the whole line, as
-- venues.address and exhibitions.address_override already store it; and splitting
-- into street/line2/borough/zip would mean twelve text columns for three
-- locations with nothing yet that queries a part on its own.
--
-- Up to three locations. Only show_location is written today: multi-location
-- shows are a deliberate fast-follow, so _2 and _3 stay NULL until then.
--
-- show_location_source records whether show_location came from the show
-- ('show') or is the venue fallback ('venue'). Without it a fallback row is
-- indistinguishable from a confirmed show address.
--
-- Forward-looking only: no backfill. Existing rows stay NULL, and published
-- rows are never rewritten by a re-scrape (only end_date is), so they stay NULL
-- until someone edits them.
--
-- Nothing reads these columns yet: the public site still resolves addresses as
-- address_override → venue address.

BEGIN;

ALTER TABLE exhibitions
  ADD COLUMN IF NOT EXISTS show_location                text,
  ADD COLUMN IF NOT EXISTS show_location_latitude       numeric,
  ADD COLUMN IF NOT EXISTS show_location_longitude      numeric,
  ADD COLUMN IF NOT EXISTS show_location_neighborhood   text,
  ADD COLUMN IF NOT EXISTS show_location_2              text,
  ADD COLUMN IF NOT EXISTS show_location_2_latitude     numeric,
  ADD COLUMN IF NOT EXISTS show_location_2_longitude    numeric,
  ADD COLUMN IF NOT EXISTS show_location_2_neighborhood text,
  ADD COLUMN IF NOT EXISTS show_location_3              text,
  ADD COLUMN IF NOT EXISTS show_location_3_latitude     numeric,
  ADD COLUMN IF NOT EXISTS show_location_3_longitude    numeric,
  ADD COLUMN IF NOT EXISTS show_location_3_neighborhood text,
  ADD COLUMN IF NOT EXISTS show_location_source         text
    CHECK (show_location_source IN ('show', 'venue'));

COMMENT ON COLUMN exhibitions.show_location IS
  'Where the show is: "<street>, [<floor/suite>, ]<borough>, New York <zip>". Venue address only as fallback — see show_location_source.';
COMMENT ON COLUMN exhibitions.show_location_source IS
  'show = address found for this show; venue = no address found, venue address used.';

-- Same projection as the rest of a published exhibition (migration_v26): where a
-- show is on view is public information, like address_override already is.
GRANT SELECT (
  show_location, show_location_latitude, show_location_longitude, show_location_neighborhood,
  show_location_2, show_location_2_latitude, show_location_2_longitude, show_location_2_neighborhood,
  show_location_3, show_location_3_latitude, show_location_3_longitude, show_location_3_neighborhood,
  show_location_source
) ON exhibitions TO anon;

COMMIT;

-- ─── Verify ──────────────────────────────────────────────────────────────────
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'exhibitions' AND column_name LIKE 'show_location%'
--   ORDER BY column_name;
--     -> 13 rows: show_location, _latitude, _longitude, _neighborhood (x3 sets), show_location_source
