// How Agent 1 decides what to do with the artist names it extracted from a show
// page: publish them, publish but hide them, or hold the show for review.
//
// Pure — no I/O, no imports — so all eight branches can be exercised directly
// against Node's TypeScript stripping with no build step and no database.
//
// The shape of the problem: an artist name can reach us two ways. Either the page
// has a dedicated credit line or artist list (CREDITED), or the name was read out
// of the title or body prose (INFERRED). Inference is much weaker evidence, and a
// group show whose names were inferred is the case most likely to be wrong, so it
// never auto-publishes. Separately, a credited group of six or more publishes with
// the names hidden, because a wall of forty names is not useful on a card — but the
// first time a venue does that, a person confirms it once.

export type ArtistProvenance = 'inferred' | 'credited'

export interface ArtistDecision {
  /** The names to store. Empty only when verification failed. */
  artists: string[]
  /** Store the names but don't show them publicly. Never means "don't store". */
  hideNames: boolean
  /** Non-null forces the show to pending, and says why. */
  pendingReason: string | null
  /** True when this is a venue's first credited group of six or more, and a
   *  person should confirm it once before the venue is allowed to auto-publish
   *  that shape again. */
  recordGroupWarning: boolean
}

/** Six or more credited artists publish with names hidden. */
export const LARGE_GROUP_MIN = 6

/**
 * The one warning type this venue-level mute covers.
 *
 * Keyed to the venue and this string — deliberately NOT to the artist count, so a
 * venue muted after a show with six artists stays muted for one with forty. They
 * are the same judgement ("this venue runs big group shows, hiding the names is
 * fine"), and re-asking per count would make the mute useless.
 */
export const GROUP_WARNING_TYPE = 'non_inferred_group_6_plus'

export interface ArtistDecisionInput {
  /** Names as extracted, in page order. */
  extracted: string[]
  /** Which of those were confirmed to actually appear on the page. */
  verified: string[]
  provenance: ArtistProvenance
  /** Has this venue already had a credited 6+ group confirmed or muted? */
  venueGroupWarningMuted: boolean
}

/**
 * Applies the artist table.
 *
 * Verification is required on every branch — nothing skips it. A partial pass
 * counts as a failure: if any extracted name could not be found on the page, the
 * set as a whole is untrustworthy (the usual cause is one hallucinated name beside
 * several real ones), so the field is emptied rather than published half-right.
 * Emptying is a display decision made here; the caller still stores whatever it
 * was given, and nothing in this module deletes stored artist data.
 */
export function decideArtists(input: ArtistDecisionInput): ArtistDecision {
  const { extracted, verified, provenance, venueGroupWarningMuted } = input

  const names = extracted.filter((n) => n && n.trim()).map((n) => n.trim())
  if (names.length === 0) {
    // No names at all is not a failure — plenty of real shows credit nobody.
    return { artists: [], hideNames: false, pendingReason: null, recordGroupWarning: false }
  }

  const verifiedSet = new Set(verified.map((n) => n.trim().toLowerCase()))
  const allAppear = names.every((n) => verifiedSet.has(n.toLowerCase()))

  if (!allAppear) {
    return {
      artists: [],
      hideNames: false,
      pendingReason: 'artist names could not be found on the page',
      recordGroupWarning: false,
    }
  }

  const isSolo = names.length === 1

  if (provenance === 'inferred') {
    if (isSolo) {
      return { artists: names, hideNames: false, pendingReason: null, recordGroupWarning: false }
    }
    // A group read out of prose, never from a credit line. Always reviewed, even
    // though every name checked out — appearing on the page proves the words are
    // there, not that they are the artist list.
    return {
      artists: names,
      hideNames: false,
      pendingReason: 'group show with artist names inferred from the page text, not a credit line',
      recordGroupWarning: false,
    }
  }

  // Credited from here down.
  if (isSolo || names.length < LARGE_GROUP_MIN) {
    return { artists: names, hideNames: false, pendingReason: null, recordGroupWarning: false }
  }

  // Credited group of six or more: names are stored and hidden. The first such
  // show at a venue is confirmed by a person; after that the venue is muted.
  if (venueGroupWarningMuted) {
    return { artists: names, hideNames: true, pendingReason: null, recordGroupWarning: false }
  }
  return {
    artists: names,
    hideNames: true,
    pendingReason: `first group show of ${LARGE_GROUP_MIN}+ credited artists at this venue — confirm hiding the names`,
    recordGroupWarning: true,
  }
}
