// Where a published exhibition is, for every public surface that places one:
// the exhibition page, the map, the exhibition list and "nearby".
//
// Priority, highest first:
//   1. address_override — a person's explicit correction always wins.
//   2. show_location   — Agent 1's resolved address for this show. Whether it
//                        came from the show's own pages or from the venue
//                        fallback (show_location_source) doesn't change its place.
//   3. the venue's own address — every exhibition scraped before show_location
//                        existed, and any show Agent 1 couldn't place.
//
// No imports, so every route shares one definition and it can be tested directly.

type Coordinate = number | string | null | undefined

export interface ExhibitionLocationFields {
  address_override?: string | null
  address_override_neighborhood?: string | null
  override_latitude?: Coordinate
  override_longitude?: Coordinate
  show_location?: string | null
  show_location_2?: string | null
  show_location_3?: string | null
  show_location_neighborhood?: string | null
  show_location_latitude?: Coordinate
  show_location_longitude?: Coordinate
}

export interface VenueLocationFields {
  address?: string | null
  neighborhood?: string | null
  latitude?: Coordinate
  longitude?: Coordinate
}

export interface ResolvedExhibitionLocation {
  /** The first address — the one the pin and coordinates belong to. */
  address: string | null
  /** Every address to display, in order: a multi-location show's scraped
   *  show_location, _2 and _3; otherwise just `address`. Only the first has coordinates. */
  addresses: string[]
  neighborhood: string | null
  lat: number | null
  lng: number | null
  /** Which level supplied the address. */
  source: 'override' | 'show' | 'venue' | null
}

// Flat-earth distance — accurate to well under a metre across a few hundred
// metres at New York's latitude, which is all a pin-grouping radius needs.
function metersBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const x = (lng2 - lng1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180)
  const y = lat2 - lat1
  return Math.sqrt(x * x + y * y) * 111_320
}

/**
 * Groups exhibitions into map pins: the same venue AND within `withinMeters` of
 * the group's first show. Shows in one building still share a pin and its paged
 * popup even when their coordinates came from different sources a few metres
 * apart (venue geocode vs. show geocode); a show resolved to somewhere else gets
 * its own pin instead of being drawn at its venue's. Different venues never
 * share a pin, as before.
 */
export function groupByPlace<T>(
  items: T[],
  place: (item: T) => { venueId: string; lat: number; lng: number },
  withinMeters = 75
): T[][] {
  const groups: { venueId: string; lat: number; lng: number; items: T[] }[] = []
  for (const item of items) {
    const p = place(item)
    const group = groups.find(
      (g) => g.venueId === p.venueId && metersBetween(g.lat, g.lng, p.lat, p.lng) <= withinMeters
    )
    if (group) group.items.push(item)
    else groups.push({ ...p, items: [item] })
  }
  return groups.map((g) => g.items)
}

// Same test the routes have always applied: both present and non-zero.
// numeric columns can arrive as strings, hence Number().
function coordinates(lat: Coordinate, lng: Coordinate): { lat: number; lng: number } | null {
  const la = Number(lat)
  const ln = Number(lng)
  return la && ln && Number.isFinite(la) && Number.isFinite(ln) ? { lat: la, lng: ln } : null
}

export function resolveExhibitionLocation(
  exhibition: ExhibitionLocationFields,
  venue: VenueLocationFields
): ResolvedExhibitionLocation {
  const override = exhibition.address_override?.trim() || null
  const show = exhibition.show_location?.trim() || null
  const venueAddress = venue.address?.trim() || null

  // Coordinates follow the same order, dropping to the next level only when a
  // level has an address but no coordinates yet — an override typed into the
  // admin isn't geocoded until the map route first sees it.
  const coords =
    (override ? coordinates(exhibition.override_latitude, exhibition.override_longitude) : null) ??
    (show ? coordinates(exhibition.show_location_latitude, exhibition.show_location_longitude) : null) ??
    coordinates(venue.latitude, venue.longitude)

  if (override) {
    return {
      address: override,
      // An override is one address a person typed; it replaces every scraped location.
      addresses: [override],
      // Unchanged from before show_location existed.
      neighborhood: exhibition.address_override_neighborhood ?? venue.neighborhood ?? null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      source: 'override',
    }
  }

  if (show) {
    const more = [exhibition.show_location_2, exhibition.show_location_3]
      .map((a) => a?.trim() || null)
      .filter((a): a is string => a !== null)
    return {
      address: show,
      addresses: [show, ...more],
      // The venue's neighborhood describes the venue's address, which a show
      // resolved to somewhere else isn't at — so no fallback to it here. A venue
      // fallback already carries the venue's neighborhood in show_location_neighborhood.
      neighborhood: exhibition.show_location_neighborhood ?? null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      source: 'show',
    }
  }

  return {
    address: venueAddress,
    addresses: venueAddress ? [venueAddress] : [],
    neighborhood: venue.neighborhood ?? null,
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    source: venueAddress ? 'venue' : null,
  }
}
