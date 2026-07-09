'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { NearbyExhibition } from '@/lib/types'
import { createPrimaryMarkerEl, createSecondaryMarkerEl } from '@/lib/mapMarkers'
import { buildPopupCard, formatArtists, formatEndDate, type PopupCardItem } from '@/lib/mapPopup'

const MAPBOX_STYLE = 'mapbox://styles/santolazarus/cmq35s95r002h01qlhnj88ivd'

interface ExhibitionMiniMapProps {
  exhibitionId: string
  lat: number
  lng: number
}

export default function ExhibitionMiniMap({ exhibitionId, lat, lng }: ExhibitionMiniMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const secondaryMarkersRef = useRef<mapboxgl.Marker[]>([])

  useEffect(() => {
    if (!containerRef.current) return

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAPBOX_STYLE,
      center: [lng, lat],
      zoom: 15,
      pitch: 0,
      bearing: 0,
    })
    mapRef.current = map

    const primaryEl = createPrimaryMarkerEl()
    new mapboxgl.Marker(primaryEl).setLngLat([lng, lat]).addTo(map)

    return () => {
      map.remove()
      mapRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    fetch(`/api/exhibitions/nearby?lat=${lat}&lng=${lng}&exclude=${exhibitionId}`)
      .then((r) => r.json())
      .then((data: NearbyExhibition[]) => {
        const map = mapRef.current
        if (!map) return

        secondaryMarkersRef.current.forEach((m) => m.remove())
        secondaryMarkersRef.current = []

        const addMarkers = () => {
          // Group by venue — a nearby venue with 2+ current shows gets one marker,
          // paged via the shared popup card's prev/next arrows, same as the other map surfaces.
          const byVenue = new Map<string, NearbyExhibition[]>()
          data.forEach((ex) => {
            const arr = byVenue.get(ex.venue_id) ?? []
            arr.push(ex)
            byVenue.set(ex.venue_id, arr)
          })

          byVenue.forEach((shows) => {
            const primary = shows[0]
            const el = createSecondaryMarkerEl()

            const items: PopupCardItem[] = shows.map((ex) => ({
              title: ex.show_title,
              subtitle: ex.artists.length ? formatArtists(ex.artists) : undefined,
              meta: ex.institution_name,
              dateLabel: ex.end_date ? `Until ${formatEndDate(ex.end_date)}` : undefined,
              imageUrl: ex.image_url,
              href: `/exhibitions/${ex.id}`,
            }))

            const popup = new mapboxgl.Popup({ closeButton: false, offset: 10, maxWidth: '375px' })
            popup.setDOMContent(buildPopupCard(items))

            const marker = new mapboxgl.Marker(el)
              .setLngLat([primary.lng, primary.lat])
              .setPopup(popup)
              .addTo(map)
            secondaryMarkersRef.current.push(marker)
          })
        }

        if (map.isStyleLoaded()) {
          addMarkers()
        } else {
          map.once('load', addMarkers)
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng, exhibitionId])

  return (
    <div className="ep-minimap-wrap">
      <div ref={containerRef} className="ep-minimap" style={{ height: '300px', width: '100%' }} />
      <Link href={`/map?add=${exhibitionId}`} className="ep-crawl-link">
        See more shows in NYC or plan an itinerary &rsaquo;
      </Link>
    </div>
  )
}
