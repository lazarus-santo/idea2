export interface Preread {
  id: string
  exhibition_id: string
  article_title: string | null
  publication: string | null
  article_url: string | null
  thumbnail_url: string | null
  summary: string | null
  created_at: string
}

export interface CoverageItem {
  url: string
  title: string | null
  author: string | null
  publication_name: string | null
  published_date: string | null
}

export interface CoverageDisplayItem {
  url: string
  title: string | null
  author: string | null
  publication_name: string | null
  published_date: string | null
  reading_id?: string
}

export interface Exhibition {
  id: string
  institution_name: string
  institution_id: string | null
  venue_name: string
  venue_type: 'gallery' | 'museum' | 'fair'
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
  address_override: string | null
  address_override_neighborhood: string | null
  lat: number | null
  lng: number | null
  artists: string[]
  preread_type: 'full' | 'coverage_only'
  prereads: {
    id: string
    article_title: string | null
    publication: string | null
    article_url: string | null
    thumbnail_url: string | null
  }[]
}

export interface NearbyExhibition {
  id: string
  show_title: string
  institution_name: string
  institution_id: string | null
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
  type: 'gallery' | 'museum' | 'fair'
  active: boolean
  institution_id?: string
  address?: string | null
  latitude?: number | null
  longitude?: number | null
  check_back_date?: string | null
  scrape_failed?: boolean
  manual_entry_required?: boolean
  scrape_failure_reason?: string | null
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

export interface ExhibitionLink {
  title: string
  url: string
  classification: 'current' | 'past' | 'permanent' | 'upcoming'
  classification_reason: string
  content_type: 'exhibition' | 'event' | 'online_only' | 'unclear'
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
  venue_type: 'gallery' | 'museum' | 'fair'
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
