'use client'

import { useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import type { VenueExhibition, VenuePreread, VenueInstitutionPin } from '@/lib/types'

const VenueMap = dynamic(() => import('./VenueMap'), { ssr: false })

type Tab = 'shows' | 'press' | 'map'
type ShowFilter = 'current' | 'past'

interface VenuePageProps {
  venue: { id: string; name: string; type: string }
  institution: { address: string | null; lat: number | null; lng: number | null } | null
  exhibitions: VenueExhibition[]
  prereads: VenuePreread[]
  allInstitutions: VenueInstitutionPin[]
}

function isCurrent(ex: VenueExhibition, today: string): boolean {
  if (ex.start_date && ex.start_date > today) return false
  if (ex.end_date && ex.end_date < today) return false
  return true
}

function ExhibitionCard({
  exhibition,
  venueName,
  dimmed,
}: {
  exhibition: VenueExhibition
  venueName: string
  dimmed: boolean
}) {
  return (
    <div className="ei-card">
      <div className="ei-card-img-wrap">
        {exhibition.image_url ? (
          <img
            src={exhibition.image_url}
            alt={exhibition.show_title}
            loading="lazy"
            className={`ei-card-img${dimmed ? ' ei-card-img--dimmed' : ''}`}
          />
        ) : (
          <div className="ei-card-img-empty" />
        )}
      </div>
      <div className="ei-card-meta">
        <Link href={`/exhibitions/${exhibition.id}`} className="ei-card-title ei-card-stretched-link">
          {exhibition.show_title}
        </Link>
        {exhibition.artists.length > 0 && (
          <p className="ei-card-artists">
            {exhibition.artists.slice(0, 3).map((name, i) => (
              <span key={name}>
                {i > 0 && ', '}
                <Link href={`/search?q=${encodeURIComponent(name)}&category=artists`} className="artist-link">{name}</Link>
              </span>
            ))}
            {exhibition.artists.length > 3 && (
              <span> +{exhibition.artists.length - 3}</span>
            )}
          </p>
        )}
        <p className="ei-card-venue">{venueName}</p>
      </div>
    </div>
  )
}

export default function VenuePage({
  venue,
  institution,
  exhibitions,
  prereads,
  allInstitutions,
}: VenuePageProps) {
  const [tab, setTab] = useState<Tab>('shows')
  const [showFilter, setShowFilter] = useState<ShowFilter>('current')

  const today = new Date().toISOString().split('T')[0]
  const currentShows = exhibitions.filter((ex) => isCurrent(ex, today))
  const pastShows = exhibitions.filter((ex) => !isCurrent(ex, today))
  const hasPastShows = pastShows.length > 0

  const visibleShows = showFilter === 'current' ? currentShows : pastShows

  const address = institution?.address ?? null
  const mapsUrl = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : null

  return (
    <div className="gp-body">
      {/* Nav — reuses ep-nav pattern */}
      <nav className="ep-nav" style={{ position: 'relative', background: '#FFFCEC' }} aria-label="Site navigation">
        <div className="ep-nav-inner">
          <Link href="/" className="ep-wordmark">Idea 2</Link>
          <div className="ep-nav-links">
            <Link href="/exhibitions">Exhibitions</Link>
            <Link href="/readings">Readings</Link>
            <Link href="/editors-picks">Editor&apos;s Picks</Link>
          </div>
          <Link href="/search" className="ep-nav-search">Search</Link>
        </div>
      </nav>

      <main className="gp-main">
        {/* Venue header */}
        <div className="gp-header">
          <h1 className="gp-name">{venue.name}</h1>
          {address && mapsUrl ? (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="gp-address"
            >
              {address}
            </a>
          ) : address ? (
            <p className="gp-address">{address}</p>
          ) : null}
        </div>

        {/* Tab bar */}
        <div className="gp-tabs" role="tablist">
          {(['shows', 'press', 'map'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`gp-tab${tab === t ? ' gp-tab--active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'shows' ? 'Shows' : t === 'press' ? 'Press' : 'Map'}
            </button>
          ))}
        </div>

        {/* Shows tab */}
        {tab === 'shows' && (
          <div role="tabpanel">
            <div className="gp-subfilters">
              <button
                className={`gp-subfilter${showFilter === 'current' ? ' gp-subfilter--active' : ''}`}
                onClick={() => setShowFilter('current')}
              >
                Currently Showing
              </button>
              {hasPastShows && (
                <button
                  className={`gp-subfilter${showFilter === 'past' ? ' gp-subfilter--active' : ''}`}
                  onClick={() => setShowFilter('past')}
                >
                  Past Shows
                </button>
              )}
            </div>

            {visibleShows.length === 0 ? (
              showFilter === 'current' ? (
                <p className="gp-empty">Nothing currently on — check back soon</p>
              ) : null
            ) : (
              <div className="ei-grid">
                {visibleShows.map((ex) => (
                  <ExhibitionCard
                    key={ex.id}
                    exhibition={ex}
                    venueName={venue.name}
                    dimmed={showFilter === 'past'}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Press tab */}
        {tab === 'press' && (
          <div className="gp-press" role="tabpanel">
            {prereads.length === 0 ? (
              <p className="gp-empty">No press yet</p>
            ) : (
              prereads.map((p) => {
                const parts = [p.publication, p.article_title].filter(Boolean)
                const label = parts.join(' — ') || p.article_url || ''
                return p.article_url ? (
                  <a
                    key={p.id}
                    href={p.article_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gp-press-item"
                  >
                    {label}
                  </a>
                ) : (
                  <span key={p.id} className="gp-press-item gp-press-item--no-url">
                    {label}
                  </span>
                )
              })
            )}
          </div>
        )}

        {/* Map tab */}
        {tab === 'map' && (
          <div role="tabpanel">
            {institution?.lat && institution?.lng ? (
              <VenueMap
                lat={institution.lat}
                lng={institution.lng}
                venueId={venue.id}
                venueName={venue.name}
                allInstitutions={allInstitutions}
              />
            ) : (
              <div className="gp-map-empty">
                <p className="gp-empty">Location not available</p>
              </div>
            )}
            <div className="gp-map-itinerary-link">
              <Link href="/map" className="gp-itinerary-cta">Create an itinerary &rsaquo;</Link>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
