'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { NearbyExhibition } from '@/lib/types'

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

    const primaryEl = document.createElement('div')
    primaryEl.style.cssText =
      'width:16px;height:16px;border-radius:50%;background:#3432A8;border:2px solid #fff;box-sizing:border-box;'
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
          data.forEach((ex) => {
            const el = document.createElement('div')
            el.style.cssText =
              'width:12px;height:12px;border-radius:50%;background:#FFFCEC;border:2px solid #3432A8;cursor:pointer;box-sizing:border-box;'

            const popup = new mapboxgl.Popup({ closeButton: false, offset: 10 }).setHTML(
              `<div style="font-family:system-ui,sans-serif;font-size:12px;line-height:1.5;color:#000;min-width:130px;padding:2px 0;">
                <div style="font-weight:600;margin-bottom:1px;">${ex.show_title}</div>
                <div style="opacity:0.55;margin-bottom:5px;">${ex.institution_name}</div>
                <a href="/exhibitions/${ex.id}" style="color:#3432A8;text-decoration:none;font-size:11px;">View Show &rsaquo;</a>
              </div>`
            )

            const marker = new mapboxgl.Marker(el)
              .setLngLat([ex.lng, ex.lat])
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
