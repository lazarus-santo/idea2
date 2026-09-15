import { geocodeAddressDetailed } from './geocode'
import { hintNamesNonNycCity, judgeSameAddress, type LocationCheck } from './claude'
import {
  boroughForZip,
  compareAddresses,
  explicitNonNycReason,
  formatStandardAddress,
  houseNumbersMatch,
  parseStreetAddress,
  placeTextAfterStreet,
  splitAddressEntry,
  streetKey,
  type ParsedAddress,
} from './address-normalize'
import type { VenueRecord } from './types'

// Check #10 of Agent 1's per-show sequence: where is this show, and is it in NYC?
//
// Evidence, strongest first:
//   1. Street addresses for the show — from the listing page (T1) and the show's
//      own page (check #4). Every address the listing page gives must also be one
//      the show page gives: normalization decides first, a model call only for
//      pairs it can't settle.
//   2. The page-level check (verifyExhibitionLocation) — the page title and a
//      model read of the page — for shows that give no address.
//   3. The venue's own address, only when no address was found anywhere, and
//      never for a show that isn't confirmed to be in New York.
//
// A show can be held at up to three locations. Each address is checked and
// standardized on its own; only the first is geocoded, because it's the map pin
// and the locations of one show sit a few minutes' walk apart.

export const MAX_SHOW_LOCATIONS = 3

export interface ResolvedLocation {
  address: string
  latitude: number | null
  longitude: number | null
  neighborhood: string | null
}

export type ShowLocationFlag = 'address_error' | 'location_unverified'

export interface ShowLocationResolution {
  /** 'non_nyc' means the show is discarded, exactly as a failed page check always was. */
  verdict: 'nyc' | 'non_nyc' | 'unknown'
  city: string | null
  /** Added to missing_fields, so either one holds the show in pending. */
  flags: ShowLocationFlag[]
  /** Up to three, in page order. Only the first carries coordinates. */
  locations: ResolvedLocation[]
  source: 'show' | 'venue' | null
  /** Extra fields for the LOCATION_CHECK log line. */
  trace: Record<string, unknown>
}

interface UsableAddress {
  raw: string
  parsed: ParsedAddress
}

// Every complete address in a list of extracted entries — joined entries split,
// duplicates dropped, page order kept — and whether any entry was a corrupted merge.
function collectAddresses(entries: string[]): { addresses: UsableAddress[]; garbled: boolean } {
  const addresses: UsableAddress[] = []
  const seen = new Set<string>()
  let garbled = false
  for (const entry of entries) {
    const split = splitAddressEntry(entry)
    garbled = garbled || split.garbled
    for (const { text, parsed } of split.addresses) {
      const identity = `${parsed.houseNumber.toLowerCase()} ${streetKey(parsed.street)}`
      if (seen.has(identity)) continue
      seen.add(identity)
      addresses.push({ raw: text, parsed })
    }
  }
  return { addresses, garbled }
}

// The city, state or zip an address names outside NYC, or null. Reads only the
// text after the street, so "88 Hudson Street" is not Hudson, NY.
function nonNycReason(address: UsableAddress): string | null {
  const zip = address.parsed.zip
  return (
    explicitNonNycReason(address.raw) ??
    (zip && !boroughForZip(zip) ? `zip ${zip}` : null) ??
    hintNamesNonNycCity(placeTextAfterStreet(address.raw, address.parsed))
  )
}

/** For the listing-page filter: the non-NYC place named, but only when every
 *  address in the list is somewhere else. A show at a NYC space and a London one
 *  still belongs in the queue. */
export function addressesNameNonNyc(entries: string[]): string | null {
  const { addresses } = collectAddresses(entries)
  if (addresses.length === 0) return null
  const reasons = addresses.map(nonNycReason)
  return reasons.every(Boolean) ? reasons[0] : null
}

// The venue's address in the standard format, with the venue's stored
// coordinates. Only a venue that was never geocoded costs a Mapbox lookup.
async function venueFallback(venue: VenueRecord): Promise<ResolvedLocation | null> {
  const raw = venue.address?.trim()
  if (!raw) return null

  const parsed = parseStreetAddress(raw)
  const address = parsed ? formatStandardAddress({ ...parsed, borough: boroughForZip(parsed.zip) }) : raw

  let latitude = venue.latitude ?? null
  let longitude = venue.longitude ?? null
  let neighborhood = venue.neighborhood ?? null
  if (latitude === null || longitude === null) {
    const geo = await geocodeAddressDetailed(raw)
    if (geo) {
      latitude = geo.lat
      longitude = geo.lng
      neighborhood = neighborhood ?? geo.neighborhood
    }
  }
  return { address, latitude, longitude, neighborhood }
}

export async function resolveShowLocation(input: {
  listingAddresses: string[]
  detailAddresses: string[]
  pageCheck: LocationCheck
  venue: VenueRecord
}): Promise<ShowLocationResolution> {
  const { pageCheck, venue } = input
  const listing = collectAddresses(input.listingAddresses)
  const detail = collectAddresses(input.detailAddresses)
  const trace: Record<string, unknown> = {
    listing_addresses: input.listingAddresses,
    detail_addresses: input.detailAddresses,
  }

  const flags: ShowLocationFlag[] = []
  // A corrupted merge is flagged whatever else happens; the pieces that did parse
  // are still used below.
  if (listing.garbled || detail.garbled) {
    flags.push('address_error')
    trace.garbled = true
  }

  // ── No address anywhere: the page check decides, the venue address fills in ──
  if (listing.addresses.length === 0 && detail.addresses.length === 0) {
    if (pageCheck.verdict === 'non_nyc') {
      return { verdict: 'non_nyc', city: pageCheck.city, flags: [], locations: [], source: null, trace: { ...trace, outcome: 'page_non_nyc' } }
    }
    // Silence is only held for review when the gallery has branches elsewhere.
    // A one-address NYC gallery saying nothing is at its own address.
    if (pageCheck.verdict === 'unknown' && pageCheck.galleryMultiCity) flags.push('location_unverified')
    const fallback = await venueFallback(venue)
    return {
      verdict: pageCheck.verdict,
      city: pageCheck.city,
      flags,
      locations: fallback ? [fallback] : [],
      source: fallback ? 'venue' : null,
      trace: { ...trace, outcome: 'venue_fallback' },
    }
  }

  // ── Listing page vs show page ──
  // Every listing-page address must be one the show page also gives. The show
  // page may give more (a listing card often shows one location), but finding
  // several addresses is never a mismatch in itself.
  if (listing.addresses.length > 0 && detail.addresses.length > 0) {
    let mismatch = false
    const modelComparisons: string[] = []
    for (const l of listing.addresses) {
      let match = detail.addresses.find((d) => compareAddresses(l.raw, d.raw) === 'same')
      if (!match) {
        for (const d of detail.addresses) {
          const judged = await judgeSameAddress(l.raw, d.raw)
          modelComparisons.push(`${l.raw} ~ ${d.raw}: ${judged}`)
          if (judged === 'same') {
            match = d
            break
          }
        }
      }
      if (match) {
        // The listing page only fills in a floor or zip the show page left out.
        match.parsed = {
          ...match.parsed,
          line2: match.parsed.line2 ?? l.parsed.line2,
          zip: match.parsed.zip ?? l.parsed.zip,
        }
      } else {
        mismatch = true
      }
    }
    trace.comparison = mismatch ? 'mismatch' : 'agree'
    if (modelComparisons.length > 0) trace.model_comparisons = modelComparisons
    if (mismatch && !flags.includes('address_error')) flags.push('address_error')
  }

  // The show's own page is the more specific source.
  const found = detail.addresses.length > 0 ? detail.addresses : listing.addresses

  // ── Addresses somewhere else ──
  // Dropped one by one; the show is discarded only when none is left, and a
  // discarded show never takes the venue fallback.
  const inNyc: UsableAddress[] = []
  const elsewhere: string[] = []
  for (const address of found) {
    const reason = nonNycReason(address)
    if (reason) elsewhere.push(reason)
    else inNyc.push(address)
  }
  if (elsewhere.length > 0) trace.dropped_non_nyc = elsewhere
  if (inNyc.length === 0) {
    return { verdict: 'non_nyc', city: elsewhere[0], flags: [], locations: [], source: null, trace: { ...trace, outcome: 'address_non_nyc' } }
  }

  // ── The first address: Mapbox (bounded to NYC, the existing integration), confirmed by zip ──
  const first = inNyc[0].parsed
  const query = [`${first.houseNumber} ${first.street}`, first.zip, 'New York, NY'].filter(Boolean).join(', ')
  const geo = await geocodeAddressDetailed(query)
  // A street-centroid or wrong-house match would put the pin in the wrong place,
  // so coordinates are only kept for the same house number in an NYC zip.
  const geoMatches =
    !!geo &&
    geo.placeType.includes('address') &&
    !!geo.houseNumber &&
    houseNumbersMatch(geo.houseNumber, first.houseNumber) &&
    boroughForZip(geo.postcode) !== null
  trace.geocode = geo ? { place: geo.placeName, matched: geoMatches } : null

  const zip = first.zip ?? (geoMatches ? geo!.postcode : null)
  const borough = boroughForZip(zip)

  if (!borough) {
    // An address nothing can place in a borough — no NYC zip, no Mapbox match.
    // That isn't proof it's elsewhere, so it isn't discarded; it's held.
    if (pageCheck.verdict === 'non_nyc') {
      return { verdict: 'non_nyc', city: pageCheck.city, flags: [], locations: [], source: null, trace: { ...trace, outcome: 'page_non_nyc' } }
    }
    return {
      verdict: 'unknown',
      city: null,
      flags: [...flags, 'location_unverified'],
      locations: [],
      source: null,
      trace: { ...trace, outcome: 'address_unresolved' },
    }
  }

  // The page check naming another city is overridden only by a fully mechanical
  // confirmation: Mapbox matched this house number inside an NYC zip. Galleries
  // with branches elsewhere mention those cities all over their pages — footers,
  // "also on view in London", boilerplate — so once the address itself is proven
  // to be in New York that text is noise, not a conflict. An address placed only
  // by its printed zip (Mapbox down, or no house-number match) hasn't cleared
  // that bar, so against another city it is still held for review.
  if (pageCheck.verdict === 'non_nyc') {
    if (geoMatches) trace.page_city_overridden = pageCheck.city
    else if (!flags.includes('address_error')) flags.push('address_error')
  }

  const locations: ResolvedLocation[] = [
    {
      address: formatStandardAddress({
        houseNumber: first.houseNumber,
        street: geoMatches && geo!.street ? geo!.street : first.street,
        line2: first.line2,
        borough,
        zip,
      }),
      latitude: geoMatches ? geo!.lat : null,
      longitude: geoMatches ? geo!.lng : null,
      neighborhood: geoMatches ? geo!.neighborhood : null,
    },
    // Further locations: standardized text, no Mapbox call. The borough comes
    // from the address's own zip; without one the line ends in "New York", which
    // the first address has already confirmed.
    ...inNyc.slice(1, MAX_SHOW_LOCATIONS).map(({ parsed }) => ({
      address: formatStandardAddress({ ...parsed, borough: boroughForZip(parsed.zip) }),
      latitude: null,
      longitude: null,
      neighborhood: null,
    })),
  ]

  return {
    verdict: 'nyc',
    city: borough,
    flags,
    locations,
    source: 'show',
    trace: { ...trace, outcome: flags.length > 0 ? 'address_held' : 'address_confirmed' },
  }
}
