'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { MapExhibition } from '@/lib/types'
import { createPrimaryMarkerEl } from '@/lib/mapMarkers'
import { buildPopupCard, formatArtists, formatEndDate, type PopupCardItem } from '@/lib/mapPopup'

const MAPBOX_STYLE = 'mapbox://styles/santolazarus/cmq35s95r002h01qlhnj88ivd'

function popupItemsFor(shows: MapExhibition[]): PopupCardItem[] {
  return shows.map((ex) => ({
    title: ex.show_title,
    subtitle: ex.artists.length ? formatArtists(ex.artists) : undefined,
    meta: ex.venue_name,
    dateLabel: ex.end_date ? `Until ${formatEndDate(ex.end_date)}` : undefined,
    imageUrl: ex.image_url,
    href: `/exhibitions/${ex.id}`,
    addAction: { href: `/map?add=${ex.id}` },
  }))
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
      const primary = shows[0]
      const lat = primary.venue_lat!
      const lng = primary.venue_lng!

      bounds.extend([lng, lat])

      const el = createPrimaryMarkerEl()
      el.style.transition = 'width 150ms ease, height 150ms ease'

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
      const popupContent = buildPopupCard(popupItemsFor(shows))
      popupContent.addEventListener('mouseenter', () => { popupOver = true; cancelClose() })
      popupContent.addEventListener('mouseleave', () => { popupOver = false; scheduleClose() })

      const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: '375px' })
      popup.setDOMContent(popupContent)

      el.addEventListener('mouseenter', () => {
        pinOver = true
        cancelClose()
        onHoverRef.current(primary.id)
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
      shows.forEach(ex => markerElsRef.current.set(ex.id, el))
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
        el.style.width = '24px'
        el.style.height = '24px'
        el.style.animation = 'eim-pin-pulse 0.6s ease-out'
      } else {
        el.style.width = '18px'
        el.style.height = '18px'
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
