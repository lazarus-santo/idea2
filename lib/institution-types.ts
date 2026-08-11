// Institution types and how they group on the public site.
//
// Five types exist in the database; the public filter bar shows four tabs,
// because nonprofit and experimental spaces share one — "Other Spaces". Keeping
// that mapping here rather than inline in each component matters: the tabs
// filter by exact match, so a type missing from every tab's list is not a
// styling bug, it is an exhibition that never renders anywhere on the site.
// Adding a sixth type means adding it to one list below, not finding three.

export const INSTITUTION_TYPES = ['gallery', 'museum', 'fair', 'nonprofit', 'experimental'] as const
export type InstitutionType = (typeof INSTITUTION_TYPES)[number]

export const VENUE_TABS = ['museum', 'gallery', 'other-spaces', 'fair'] as const
export type VenueTab = (typeof VENUE_TABS)[number]

export const TAB_LABEL: Record<VenueTab, string> = {
  museum: 'Museums',
  gallery: 'Galleries',
  'other-spaces': 'Other Spaces',
  fair: 'Fairs',
}

// Which institution types each tab matches.
export const TAB_TYPES = {
  museum: ['museum'],
  gallery: ['gallery'],
  'other-spaces': ['nonprofit', 'experimental'],
  fair: ['fair'],
} as const satisfies Record<VenueTab, readonly InstitutionType[]>

export function tabMatches(tab: VenueTab, venueType: string): boolean {
  return (TAB_TYPES[tab] as readonly string[]).includes(venueType)
}

// Compile-time proof that every institution type is reachable from some tab.
//
// This exists because the failure mode is invisible rather than loud: the tabs
// filter by exact match, so a type absent from TAB_TYPES does not throw, it just
// means those exhibitions never render anywhere on the public site — which is
// how 'nonprofit' could sit in the seed dropdown for months without anyone
// noticing there was nowhere for it to land.
//
// Add a sixth type to INSTITUTION_TYPES without routing it and `tsc --noEmit`
// fails here, during the build, instead of in production.
type RoutedType = (typeof TAB_TYPES)[VenueTab][number]
type MustBeNever<T extends never> = T
export type EveryTypeIsRoutedToATab = MustBeNever<Exclude<InstitutionType, RoutedType>>
