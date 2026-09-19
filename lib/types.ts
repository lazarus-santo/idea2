import type { InstitutionType } from './institution-types'
import type { ScrapeStatus } from './venue-scrape-schedule'

export type CoverageType = 'show_coverage' | 'artist_profile' | 'artist_interview' | 'past_show' | 'general'

export interface Preread {
  id: string
  exhibition_id: string
  article_title: string | null
  publication: string | null
  article_url: string | null
  thumbnail_url: string | null
  summary: string | null
  created_at: string
  // Added for museum/fair coverage (migration_v35). item_coverage_type is still
  // museum/fair-only — gallery has no equivalent classification concept, so it
  // stays null/omitted on every gallery row. artist_name, author, and
  // published_date are no longer museum/fair-exclusive: toPrereadRow() now
  // populates them from the same underlying Exa fields toCoverageItem() always
  // has (artist_name only on per-artist gallery rows, not show-review rows,
  // which — like museum/fair's own show-level searches — have no single bound
  // artist to attach).
  artist_name?: string | null
  // Named item_coverage_type, not coverage_type — exhibitions.coverage_type is
  // the unrelated museum classification ('solo' / 'group_show', migration_v59).
  item_coverage_type?: CoverageType | null
  author?: string | null
  // ISO-8601 datetime string (Exa's native publishedDate format), not a bare
  // date — see migration_v35 for why the column is timestamptz.
  published_date?: string | null
  // migration_v53. Both optional here so the generators, which never set
  // row_status (the database defaults it, and blanks any flagged row by
  // trigger), don't have to spell it out.
  quality_flag?: QualityFlag | null
  row_status?: RowStatus
}

// migration_v53 — see lib/agent2.ts for what each value means and who sets it.
export const PREREAD_STATUSES = ['pending_artists', 'pending_press_release', 'empty', 'error', 'success', 'needs_review'] as const
export type PrereadStatus = (typeof PREREAD_STATUSES)[number]

export const QUALITY_FLAGS = ['self_sourced', 'unverified', 'no_content', 'mismatched'] as const
export type QualityFlag = (typeof QUALITY_FLAGS)[number]

export const ROW_STATUSES = ['active', 'blanked'] as const
export type RowStatus = (typeof ROW_STATUSES)[number]

export interface CoverageItem {
  url: string
  title: string
  author: string | null
  publication: string | null
  published_date: string | null
  coverage_type: CoverageType
  artist_name: string | null
  thumbnail_url: string | null
}

export interface CoverageDisplayItem {
  url: string
  title: string | null
  author: string | null
  publication: string | null
  published_date: string | null
  thumbnail_url: string | null
  reading_id?: string
}

export interface Exhibition {
  id: string
  institution_name: string
  institution_id: string | null
  venue_name: string
  venue_type: InstitutionType
  venue_url: string
  venue_address: string | null
  resolved_address: string | null
  resolved_neighborhood: string | null
  address_override: string | null
  address_override_neighborhood: string | null
  show_title: string
  artists: string[]
  start_date: string | null
  end_date: string | null
  is_ongoing: boolean
  description: string | null
  press_release: string | null
  image_url: string | null
  status: string
  missing_fields: string[]
  check_back_date: string | null
  created_at: string
  updated_at: string
  prereads?: Preread[]
}

export interface ExhibitionDetailData {
  id: string
  show_title: string
  start_date: string | null
  end_date: string | null
  is_ongoing: boolean
  press_release: string | null
  image_url: string | null
  institution_name: string
  institution_id: string | null
  venue_address: string | null
  venue_neighborhood: string | null
  resolved_address: string | null
  /** Every address to show, in order — more than one for a multi-location show. */
  resolved_addresses: string[]
  address_override: string | null
  address_override_neighborhood: string | null
  lat: number | null
  lng: number | null
  artists: string[]
  preread_type: 'full' | 'coverage_only'
  venue_type: InstitutionType
  /**
   * Fairs only — exhibiting galleries as printed on the fair's own list.
   * `section` is the fair's grouping (Armory: Galleries / Solo / Focus /
   * Presents / Platform / Not-For-Profit); null for fairs with one flat list.
   */
  exhibitors: { name: string; section: string | null }[]
  prereads: {
    id: string
    article_title: string | null
    publication: string | null
    article_url: string | null
    thumbnail_url: string | null
  }[]
  coverage: CoverageDisplayItem[]
}

export interface NearbyExhibition {
  id: string
  show_title: string
  institution_name: string
  institution_id: string | null
  venue_id: string
  image_url: string | null
  end_date: string | null
  artists: string[]
  lat: number
  lng: number
}

export interface VenueExhibition {
  id: string
  show_title: string
  artists: string[]
  image_url: string | null
  start_date: string | null
  end_date: string | null
}

export interface VenuePreread {
  id: string
  article_title: string | null
  publication: string | null
  article_url: string | null
  created_at: string
}

export interface VenueInstitutionPin {
  id: string
  institution_id: string | null
  name: string
  lat: number | null
  lng: number | null
}

export interface VenueRecord {
  id: string
  name: string
  exhibitions_url: string
  type: InstitutionType
  active: boolean
  institution_id?: string
  address?: string | null
  neighborhood?: string | null
  latitude?: number | null
  longitude?: number | null
  check_back_date?: string | null
  scrape_failed?: boolean
  manual_entry_required?: boolean
  scrape_failure_reason?: string | null
  // Free-text hint handed to the extraction prompt, e.g. "current shows are
  // under the On View tab". Written only by a person.
  scrape_notes?: string | null
  // A human decision not to scrape this venue at all. Distinct from
  // manual_entry_required, which the scraper sets and clears itself.
  scrapable?: boolean
  /** From the parent institution. Set by hand — true when the institution runs
   *  exhibition space outside NYC. Gates the location_hint retry ladder. */
  is_multi_city?: boolean
  /** Anchor-window size that last yielded location hints here. Null = never
   *  established, start the ladder at its first rung. */
  location_window_size?: number | null
  /** Permanent weekly slot, 0=Sunday..6=Saturday in New York. Null = unassigned,
   *  never queued. */
  scrape_day_of_week?: number | null
  /** Agent 1 queue state — rules in lib/venue-scrape-schedule.ts. */
  scrape_status?: ScrapeStatus
  scrape_status_changed_at?: string | null
  scrape_failures?: number
}

export interface ExhibitionRaw {
  show_title: string
  artists: string[]
  start_date: string | null
  end_date: string | null
  description: string | null
  press_release: string | null
  image_url: string | null
}

/**
 * How much the listing page itself said about when a show runs.
 *  - 'dated'   real date text, or a classification the model justified with dates
 *  - 'ongoing' a status word used in place of dates ("Ongoing", "long-term view")
 *  - 'none'    nothing — the listing page gave no date signal at all
 *
 * 'none' is never grounds to discard at Section 3: it means "ask the detail page",
 * not "this is past". Only Section 4, having fetched the real page, may discard on
 * dates. Set during Section 3, not by Tier 1.
 */
export type DateEvidence = 'dated' | 'ongoing' | 'none'

export interface ExhibitionLink {
  title: string
  url: string
  classification: 'current' | 'past' | 'permanent' | 'upcoming'
  classification_reason: string
  /**
   * 'fair' and 'offsite' are shows the listing page carries but that are not on
   * at the venue's own space — an art-fair booth, or a loan/collaboration at
   * another institution. Both are excluded like 'event' and 'online_only'; they
   * are separate values so the discard log says which kind it was.
   */
  content_type: 'exhibition' | 'event' | 'online_only' | 'fair' | 'offsite' | 'unclear'
  /** Place text seen next to the link on the listing page, verbatim, or null.
   *  Only ever used to discard clearly non-NYC links early — never to confirm a
   *  link is in NYC. Tier 2/3 have no page content, so they always emit null. */
  location_hint: string | null
  /** Street addresses shown next to the link on the listing page (up to 3), or [].
   *  Compared against the show page's addresses at check #10. Tier 2/3 always emit []. */
  addresses: string[]
  /** Date text printed next to the link on the listing page, verbatim, or null —
   *  a range, an open-ended date, or a status word ("Ongoing"). Never parsed here:
   *  the year the page omits is inferred at the detail stage. Carried through the
   *  run for Section 3's filtering and logged next to the detail stage's own dates.
   *  The URL-only fallback has no page text, so it always emits null. */
  date_hint: string | null
  /** Set by Section 3 from date_hint and the classification reasoning, then read
   *  at the cap (ongoing shows bypass it) and at check #4 (a link that had no
   *  date signal here is discarded only if the detail page has none either). */
  date_evidence?: DateEvidence
  /** Set by Section 3: a 'current' show whose listing text names no closing date.
   *  Bypasses the cap so it can't be squeezed out for lacking a close date it may
   *  never have had. Independent of date_evidence, which still governs the check #4
   *  discard. */
  cap_exempt?: boolean
}

export interface ExhibitionDetailExtracted {
  title: string | null
  artists: string[]
  start_date: string | null
  end_date: string | null
  date_notes: string | null
  description: string | null
  image_url: string | null
  press_release_url: string | null
  show_type: 'exhibition' | 'installation'
  artist_bio: string | null
  /** Street addresses where this show is on view — up to 3, one location per
   *  entry, each with its city and zip — or []. */
  addresses: string[]
  /**
   * How the artist names were obtained.
   *
   * true  — read out of the title or body prose, with no credit line to back them
   * false — taken from a dedicated artist list or credit line on the page
   *
   * Page-level rather than per-artist on purpose: the rules in lib/artist-rules.ts
   * treat a show's artist list as one set, so per-name provenance would buy
   * nothing and would change `artists` from string[] into objects across the
   * scraper, museum coverage, the audit and six public read sites.
   */
  artists_inferred: boolean
}

export type VenueHours = {
  monday?: [string, string] | null
  tuesday?: [string, string] | null
  wednesday?: [string, string] | null
  thursday?: [string, string] | null
  friday?: [string, string] | null
  saturday?: [string, string] | null
  sunday?: [string, string] | null
}

export interface MapExhibition {
  id: string
  show_title: string
  artists: string[]
  institution_name: string
  institution_id: string | null
  venue_type: InstitutionType
  image_url: string | null
  start_date: string | null
  end_date: string | null
  venue_id: string
  venue_name: string
  venue_lat: number | null
  venue_lng: number | null
  venue_hours: VenueHours | null
  venue_address: string | null
}

export interface ItineraryStop {
  exhibitionId: string
  exhibition: MapExhibition
  minutesAtVenue: number
}

export interface DirectionLeg {
  walkingMinutes: number | null
  drivingMinutes: number | null
}

export interface Reading {
  id: string
  publication_id: string | null
  publication_name: string | null
  author: string | null
  headline: string
  article_url: string
  thumbnail_url: string | null
  rss_summary: string | null
  top_story: boolean
  top_story_candidate: boolean
  published_at: string | null
  created_at: string
  category:
    | 'breaking_news'
    | 'institutional_news'
    | 'art_market'
    | 'interview'
    | 'opinion'
    | 'show_review'
    | 'show_roundup'
    | null
  river_group: 'news' | 'art_market' | 'people' | 'opinion' | null
  art_relevance_score: number | null
  nyc_relevance_score: number | null
  major_artist: boolean
  significant_announcement: boolean
  tier: string | null
}
