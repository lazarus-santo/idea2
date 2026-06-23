'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import type { Exhibition, MapExhibition } from '@/lib/types'
import ExhibitionsSplitView from './ExhibitionsSplitView'
import ExhibitionFilters from './ExhibitionFilters'

type Tab = 'museums' | 'galleries' | 'fairs'
type SubFilter = 'closing-soon' | 'opening-soon' | null
type ViewMode = 'grid' | 'split'

const TAB_LABEL: Record<Tab, string> = { museums: 'Museums', galleries: 'Galleries', fairs: 'Fairs' }
const TAB_TYPE: Record<Tab, string> = { museums: 'museum', galleries: 'gallery', fairs: 'fair' }

function isClosingSoon(ex: { end_date: string | null; start_date: string | null; venue_type: string }): boolean {
  if (!ex.end_date) return false
  const now = Date.now()
  const diff = (new Date(ex.end_date + 'T00:00:00').getTime() - now) / 86400000
  if (ex.venue_type === 'fair') {
    // Fairs only show as closing soon when they are currently live
    const isLive = ex.start_date ? new Date(ex.start_date + 'T00:00:00').getTime() <= now : true
    return isLive && diff >= 0 && diff <= 7
  }
  return diff >= 0 && diff <= 7
}

function isOpeningSoon(ex: { start_date: string | null }): boolean {
  if (!ex.start_date) return false
  const diff = (new Date(ex.start_date + 'T00:00:00').getTime() - Date.now()) / 86400000
  return diff >= 0 && diff <= 7
}

function ExhibitionCard({ exhibition }: { exhibition: Exhibition }) {
  return (
    <div className="ei-card">
      <div className="ei-card-img-wrap">
        {exhibition.image_url ? (
          <img
            src={exhibition.image_url}
            alt={exhibition.show_title}
            loading="lazy"
            className="ei-card-img"
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
        {exhibition.institution_id ? (
          <Link href={`/venues/${exhibition.institution_id}`} className="ei-card-venue ei-card-venue--link">
            {exhibition.institution_name}
          </Link>
        ) : (
          <p className="ei-card-venue">{exhibition.institution_name}</p>
        )}
      </div>
    </div>
  )
}

export default function ExhibitionsPage() {
  const [exhibitions, setExhibitions] = useState<Exhibition[]>([])
  const [mapExhibitions, setMapExhibitions] = useState<MapExhibition[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('galleries')
  const [subFilter, setSubFilter] = useState<SubFilter>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [mapFetched, setMapFetched] = useState(false)

  useEffect(() => {
    fetch('/api/exhibitions')
      .then(r => r.json())
      .then(data => { setExhibitions(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  // Lazy-fetch map exhibitions when split view is first activated
  useEffect(() => {
    if (viewMode !== 'split' || mapFetched) return
    setMapFetched(true)
    fetch('/api/map-exhibitions')
      .then(r => r.json())
      .then((data: MapExhibition[]) => setMapExhibitions(data))
      .catch(() => {})
  }, [viewMode, mapFetched])

  // Filtered grid exhibitions
  let visibleGrid = exhibitions.filter(ex => ex.venue_type === TAB_TYPE[tab])
  if (subFilter === 'closing-soon') visibleGrid = visibleGrid.filter(isClosingSoon)
  if (subFilter === 'opening-soon') visibleGrid = visibleGrid.filter(isOpeningSoon)

  // Filtered map exhibitions — memoized so hoveredId changes don't produce a new array
  // reference and re-trigger the markers useEffect in ExhibitionsSplitView
  const visibleMap = useMemo(() => {
    let result = mapExhibitions.filter(ex => ex.venue_type === TAB_TYPE[tab])
    if (subFilter === 'closing-soon') result = result.filter(isClosingSoon)
    if (subFilter === 'opening-soon') result = result.filter(isOpeningSoon)
    return result
  }, [mapExhibitions, tab, subFilter])

  function toggleFilter(f: SubFilter) {
    setSubFilter(prev => (prev === f ? null : f))
  }

  function switchTab(t: Tab) {
    setTab(t)
    setSubFilter(null)
  }

  return (
    <div className={`ei-page${viewMode === 'split' ? ' ei-page--split' : ''}`}>
      <nav className="ei-nav">
        <div className="ep-nav-inner">
          <Link href="/" className="ep-wordmark">Idea 2</Link>
          <div className="ep-nav-links">
            <Link href="/exhibitions">Exhibitions</Link>
            <Link href="/readings">Readings</Link>
            <Link href="/editors-picks">Editor&rsquo;s Picks</Link>
          </div>
          <Link href="/search" className="ep-nav-search">Search</Link>
        </div>
      </nav>

      <main className="ei-main">
        <div className="ei-controls">
          <ExhibitionFilters
            tabs={(Object.keys(TAB_LABEL) as Tab[]).map(t => ({ label: TAB_LABEL[t], value: t }))}
            activeTab={tab}
            subFilter={subFilter}
            onTabChange={t => switchTab(t as Tab)}
            onSubFilterToggle={toggleFilter}
          />

          {/* Grid / Map toggle */}
          <div className="eim-toggle">
            <button
              className={`eim-toggle-btn${viewMode === 'grid' ? ' eim-toggle-btn--active' : ''}`}
              onClick={() => setViewMode('grid')}
            >
              Grid
            </button>
            <button
              className={`eim-toggle-btn${viewMode === 'split' ? ' eim-toggle-btn--active' : ''}`}
              onClick={() => setViewMode('split')}
            >
              Map
            </button>
          </div>
        </div>

        {/* Grid view */}
        {viewMode === 'grid' && (
          loading ? (
            <div className="ei-grid">
              <div className="ei-card-skeleton" />
              <div className="ei-card-skeleton" />
            </div>
          ) : visibleGrid.length === 0 ? (
            <p className="ei-empty">Nothing here yet.</p>
          ) : (
            <div className="ei-grid">
              {visibleGrid.map(ex => <ExhibitionCard key={ex.id} exhibition={ex} />)}
            </div>
          )
        )}

        {/* Split view — inside ei-main so it inherits the shared container margin/centering */}
        {viewMode === 'split' && (
          <ExhibitionsSplitView
            exhibitions={visibleMap}
            hoveredId={hoveredId}
            onHover={setHoveredId}
          />
        )}
      </main>
    </div>
  )
}
