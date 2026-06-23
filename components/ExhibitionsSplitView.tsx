'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { MapExhibition } from '@/lib/types'

const MAPBOX_STYLE = 'mapbox://styles/santolazarus/cmq35s95r002h01qlhnj88ivd'

function formatEndDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatArtists(artists: string[]): string {
  if (artists.length <= 3) return artists.join(', ')
  return `${artists.slice(0, 3).join(', ')} +${artists.length - 3}`
}

// Single-show popup — uses mp-popup classes to match the standalone map
function buildSinglePopupEl(ex: MapExhibition): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'mp-popup'

  if (ex.image_url) {
    const img = document.createElement('img')
    img.src = ex.image_url
    img.alt = ex.show_title
    img.className = 'mp-popup-thumb'
    wrap.appendChild(img)
  }

  const body = document.createElement('div')
  body.className = 'mp-popup-body'

  const title = document.createElement('p')
  title.className = 'mp-popup-title'
  title.textContent = ex.show_title
  body.appendChild(title)

  if (ex.artists.length) {
    const artists = document.createElement('p')
    artists.className = 'mp-popup-artist'
    artists.textContent = formatArtists(ex.artists)
    body.appendChild(artists)
  }

  const gallery = document.createElement('p')
  gallery.className = 'mp-popup-gallery'
  gallery.textContent = ex.venue_name
  body.appendChild(gallery)

  if (ex.end_date) {
    const date = document.createElement('p')
    date.className = 'mp-popup-date'
    date.textContent = `Until ${formatEndDate(ex.end_date)}`
    body.appendChild(date)
  }

  const actions = document.createElement('div')
  actions.className = 'mp-popup-actions'

  const viewLink = document.createElement('a')
  viewLink.href = `/exhibitions/${ex.id}`
  viewLink.className = 'mp-popup-view'
  viewLink.textContent = 'View Show'
  actions.appendChild(viewLink)

  const itinLink = document.createElement('a')
  itinLink.href = `/map?add=${ex.id}`
  itinLink.className = 'mp-popup-add'
  itinLink.textContent = '+ Add to itinerary'
  actions.appendChild(itinLink)

  body.appendChild(actions)
  wrap.appendChild(body)
  return wrap
}

// Multi-show popup for venues with multiple exhibitions
function buildMultiPopupEl(shows: MapExhibition[]): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'mp-popup mp-popup--multi'

  const header = document.createElement('p')
  header.className = 'mp-popup-gallery mp-popup-venue-header'
  header.textContent = shows[0].venue_name
  wrap.appendChild(header)

  shows.forEach((ex, i) => {
    if (i > 0) {
      const divider = document.createElement('hr')
      divider.className = 'mp-popup-divider'
      wrap.appendChild(divider)
    }

    const row = document.createElement('div')
    row.className = 'mp-popup-body'

    const title = document.createElement('p')
    title.className = 'mp-popup-title'
    title.textContent = ex.show_title
    row.appendChild(title)

    if (ex.artists.length) {
      const artists = document.createElement('p')
      artists.className = 'mp-popup-artist'
      artists.textContent = formatArtists(ex.artists)
      row.appendChild(artists)
    }

    if (ex.end_date) {
      const date = document.createElement('p')
      date.className = 'mp-popup-date'
      date.textContent = `Until ${formatEndDate(ex.end_date)}`
      row.appendChild(date)
    }

    const actions = document.createElement('div')
    actions.className = 'mp-popup-actions'

    const viewLink = document.createElement('a')
    viewLink.href = `/exhibitions/${ex.id}`
    viewLink.className = 'mp-popup-view'
    viewLink.textContent = 'View Show'
    actions.appendChild(viewLink)

    const itinLink = document.createElement('a')
    itinLink.href = `/map?add=${ex.id}`
    itinLink.className = 'mp-popup-add'
    itinLink.textContent = '+ Add to itinerary'
    actions.appendChild(itinLink)

    row.appendChild(actions)
    wrap.appendChild(row)
  })

  return wrap
}

// Left-panel card — same ei-card structure as the grid, with hover sync
function SplitCard({
  exhibition,
  isHovered,
  onMouseEnter,
  onMouseLeave,
}: {
  exhibition: MapExhibition
  isHovered: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
}) {
  return (
    <div
      className={`ei-card${isHovered ? ' eim-split-card--hovered' : ''}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
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
        <Link
          href={`/exhibitions/${exhibition.id}`}
          className="ei-card-title ei-card-stretched-link"
        >
          {exhibition.show_title}
        </Link>
        {exhibition.artists.length > 0 && (
          <p className="ei-card-artists">
            {exhibition.artists.slice(0, 3).join(', ')}
            {exhibition.artists.length > 3 && ` +${exhibition.artists.length - 3}`}
          </p>
        )}
        {exhibition.institution_id ? (
          <Link
            href={`/venues/${exhibition.institution_id}`}
            className="ei-card-venue ei-card-venue--link"
          >
            {exhibition.institution_name}
          </Link>
        ) : (
          <p className="ei-card-venue">{exhibition.institution_name}</p>
        )}
      </div>
    </div>
  )
}

interface Props {
  exhibitions: MapExhibition[]
  hoveredId: string | null
  onHover: (id: string | null) => void
}

export default function ExhibitionsSplitView({ exhibitions, hoveredId, onHover }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markerElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover
  const hasFitRef = useRef(false)
  const activePopupRef = useRef<mapboxgl.Popup | null>(null)
  // Prevents map background click from closing a popup that was just opened by a pin click
  const pinClickedRef = useRef(false)

  useEffect(() => {
    if (!mapContainerRef.current) return
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAPBOX_STYLE,
      center: [-73.97, 40.72],
      zoom: 11,
      pitch: 0,
      bearing: 0,
    })
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left')
    // Clicking the map background closes any open popup — but skip if a pin was just clicked
    // (pin clicks bubble to the map container and would immediately re-close the popup)
    map.on('click', () => {
      if (pinClickedRef.current) { pinClickedRef.current = false; return }
      activePopupRef.current?.remove()
      activePopupRef.current = null
    })
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    activePopupRef.current?.remove()
    activePopupRef.current = null

    markersRef.current.forEach(m => m.remove())
    markersRef.current = []
    markerElsRef.current.clear()

    const withCoords = exhibitions.filter(ex => ex.venue_lat && ex.venue_lng)
    if (!withCoords.length) return

    const bounds = new mapboxgl.LngLatBounds()

    // Group by venue to detect co-located exhibitions for jitter
    const byVenue = new Map<string, MapExhibition[]>()
    withCoords.forEach(ex => {
      const arr = byVenue.get(ex.venue_id) ?? []
      arr.push(ex)
      byVenue.set(ex.venue_id, arr)
    })

    byVenue.forEach(shows => {
      shows.forEach((ex, idx) => {
        const jitterAngle = shows.length > 1 ? (2 * Math.PI * idx) / shows.length : 0
        const jitterR = shows.length > 1 ? 0.0003 : 0
        const lat = ex.venue_lat! + jitterR * Math.cos(jitterAngle)
        const lng = ex.venue_lng! + jitterR * Math.sin(jitterAngle)

        bounds.extend([lng, lat])

        const el = document.createElement('div')
        el.style.cssText =
          'width:14px;height:14px;border-radius:50%;background:#3432A8;' +
          'border:2px solid #FFFCEC;cursor:pointer;box-sizing:border-box;' +
          'transition:width 150ms ease,height 150ms ease;'

        let pinOver = false
        let popupOver = false
        let closeTimer: ReturnType<typeof setTimeout> | null = null

        function scheduleClose() {
          closeTimer = setTimeout(() => {
            if (!pinOver && !popupOver) popup.remove()
          }, 200)
        }

        function cancelClose() {
          if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
        }

        // Attach hover listeners directly to the content element — more reliable than
        // popup.on('open') + getElement(), which can miss events on first render
        const popupContent = buildSinglePopupEl(ex)
        popupContent.addEventListener('mouseenter', () => { popupOver = true; cancelClose() })
        popupContent.addEventListener('mouseleave', () => { popupOver = false; scheduleClose() })

        const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 14, maxWidth: '375px' })
        popup.setDOMContent(popupContent)

        el.addEventListener('mouseenter', () => {
          pinOver = true
          cancelClose()
          onHoverRef.current(ex.id)
        })

        el.addEventListener('mouseleave', () => {
          pinOver = false
          onHoverRef.current(null)
          scheduleClose()
        })

        el.addEventListener('click', () => {
          pinClickedRef.current = true
          if (activePopupRef.current && activePopupRef.current !== popup) {
            activePopupRef.current.remove()
          }
          if (!popup.isOpen()) {
            popup.setLngLat([lng, lat]).addTo(map)
            activePopupRef.current = popup
          }
        })

        popup.on('close', () => {
          if (activePopupRef.current === popup) activePopupRef.current = null
        })

        const marker = new mapboxgl.Marker(el)
          .setLngLat([lng, lat])
          .addTo(map)

        markersRef.current.push(marker)
        markerElsRef.current.set(ex.id, el)
      })
    })

    if (!hasFitRef.current) {
      hasFitRef.current = true
      const fit = () => {
        if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 700 })
      }
      map.isStyleLoaded() ? fit() : map.once('load', fit)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exhibitions])

  useEffect(() => {
    markerElsRef.current.forEach((el, id) => {
      if (id === hoveredId) {
        el.style.width = '20px'
        el.style.height = '20px'
        el.style.animation = 'eim-pin-pulse 0.6s ease-out'
      } else {
        el.style.width = '14px'
        el.style.height = '14px'
        el.style.animation = ''
      }
    })
  }, [hoveredId])

  return (
    <div className="eim-split">
      <div className="eim-list-panel">
        {exhibitions.length === 0 ? (
          <p className="ei-empty">Nothing here yet.</p>
        ) : (
          <div className="ei-grid">
            {exhibitions.map(ex => (
              <SplitCard
                key={ex.id}
                exhibition={ex}
                isHovered={hoveredId === ex.id}
                onMouseEnter={() => onHover(ex.id)}
                onMouseLeave={() => onHover(null)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="eim-map-panel">
        <div className="eim-map-inner">
          <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
    </div>
  )
}
