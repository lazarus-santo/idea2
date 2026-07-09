'use client'

import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { VenueInstitutionPin } from '@/lib/types'
import { createPrimaryMarkerEl, createSecondaryMarkerEl } from '@/lib/mapMarkers'
import { buildPopupCard } from '@/lib/mapPopup'

function haversineDistanceMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 3959
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

interface VenueMapProps {
  lat: number
  lng: number
  venueId: string
  venueName: string
  allInstitutions: VenueInstitutionPin[]
}

export default function VenueMap({
  lat,
  lng,
  venueId,
  allInstitutions,
}: VenueMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/santolazarus/cmq35s95r002h01qlhnj88ivd',
      center: [lng, lat],
      zoom: 15,
    })

    // Primary marker — this venue
    const primaryEl = createPrimaryMarkerEl()
    new mapboxgl.Marker(primaryEl).setLngLat([lng, lat]).addTo(map)

    // Secondary markers — other active venues within 1 mile
    const nearby = allInstitutions.filter((v) => {
      if (!v.lat || !v.lng) return false
      if (v.institution_id === venueId) return false
      return haversineDistanceMiles(lat, lng, v.lat, v.lng) <= 1
    })

    nearby.forEach((v) => {
      if (!v.lat || !v.lng) return

      const el = createSecondaryMarkerEl()
      const targetId = v.institution_id ?? v.id
      const popup = new mapboxgl.Popup({ closeButton: false, offset: 10, maxWidth: '375px' })
      popup.setDOMContent(
        buildPopupCard([{ title: v.name, href: `/venues/${targetId}`, linkLabel: 'View Gallery' }])
      )

      new mapboxgl.Marker(el).setLngLat([v.lng, v.lat]).setPopup(popup).addTo(map)
    })

    return () => map.remove()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={containerRef} className="gp-map" />
}
