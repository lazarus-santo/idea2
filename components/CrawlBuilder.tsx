'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import {
  deleteCrawl,
  renameCrawl,
  saveCrawlStops,
  setCrawlStatus,
} from '@/lib/crawl-writes'
import {
  CRAWL_MAX_STOPS,
  type Crawl,
  type CrawlRoute,
  type CrawlStopDetail,
  type CrawlStatus,
} from '@/lib/crawl-types'
import type { MapExhibition } from '@/lib/types'

/**
 * Building one crawl: the stops, their order, and the walking line between them.
 *
 * ── WHAT IS NEW HERE, AND WHAT IS BORROWED ─────────────────────────────────
 *
 * Borrowed from the existing /map: Mapbox itself, the access token, the style,
 * and the idea of a map beside a list. Nothing in components/StandaloneMap.tsx
 * is changed, imported or moved — the itinerary tool keeps working exactly as
 * it did, and this is a separate page with a separate table behind it.
 *
 * New, because the itinerary tool has none of it: a LINE traced between the
 * stops along real walking directions, and pins that carry their sequence
 * number and venue name on the map itself ("1. Gagosian") rather than only in
 * the list. Those two are the feature.
 *
 * ── THE DRAFT, AND WHY SAVING IS ONE BUTTON ────────────────────────────────
 *
 * `stops` is the order being worked on; `saved` is what the database last
 * accepted. Everything the person does — add, remove, move — changes the first
 * and not the second, and Save sends the whole list once.
 *
 * That is the shape of the write, not a UI preference. migration_v66 grants no
 * row-level writes on crawl_stops at all: the only way in is set_crawl_stops(),
 * which empties the crawl and lays the new order down in one transaction. See
 * lib/crawl-writes.ts. Saving on every ↑ would also redraw the route each
 * time, spending a handful of walking-directions requests on orders nobody
 * chose on the way to the one they did.
 *
 * The route line, by contrast, IS redrawn as the draft changes — debounced.
 * Seeing the walk is the point of arranging it, so it has to follow the draft
 * rather than the saved list.
 *
 * ── WHERE EACH PIECE OF A STOP COMES FROM ──────────────────────────────────
 *
 * Two sources, merged by `info` below, and the merge is not redundancy:
 *
 *   /api/crawls/[id]/stops  the stops already saved, INCLUDING shows that have
 *                           since closed. The only source that knows about
 *                           those, because the candidate list is current shows.
 *   /api/map-exhibitions    everything addable, which is what the picker
 *                           offers and where a just-added stop gets its title
 *                           and coordinates before any save has happened.
 *
 * A stop is looked up in the saved details first, so a closed show keeps its
 * real title rather than becoming unknown the moment it leaves the map feed.
 */

/*
 * THE PROJECT'S OWN STYLE, not one of Mapbox's defaults.
 *
 * The same value StandaloneMap and ExhibitionMiniMap declare. It is repeated
 * here rather than shared because those two are out of scope for this phase
 * and hoisting it would mean editing them; if a fourth map appears, this is
 * the point to pull all four into one constant.
 *
 * It is not interchangeable with mapbox://styles/mapbox/light-v11. The public
 * token this app ships is scoped to the account's own styles, so a default
 * style silently fails to load — the map renders as an empty rectangle while
 * mapbox-gl retries the style request, which pegs the page. Reusing Mapbox's
 * existing setup means reusing this URL, not just the library.
 */
const MAPBOX_STYLE = 'mapbox://styles/santolazarus/cmq35s95r002h01qlhnj88ivd'

/** Everything the builder needs to draw one stop, from whichever source had it. */
interface StopInfo {
  title: string
  venue_name: string
  lat: number | null
  lng: number | null
  end_date: string | null
  on_view: boolean
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function formatEnd(dateStr: string | null): string | null {
  if (!dateStr) return null
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

/**
 * The pin drawn at a stop: its number and the venue's name, on the map.
 *
 * Built as a DOM element and handed to a Mapbox Marker rather than drawn as a
 * symbol layer. A symbol layer would hide labels that collide, which is exactly
 * wrong here — two galleries on the same block are the normal case in Chelsea,
 * and a crawl whose stop 4 is invisible because stop 3 is next door is a crawl
 * you cannot read. Markers always draw. They can overlap, which is legible;
 * they cannot silently disappear, which is not.
 */
function createStopMarkerEl(position: number, venueName: string, muted: boolean): HTMLDivElement {
  const el = document.createElement('div')
  el.className = muted ? 'cb-pin cb-pin--muted' : 'cb-pin'

  const num = document.createElement('span')
  num.className = 'cb-pin-num'
  num.textContent = String(position)

  const label = document.createElement('span')
  label.className = 'cb-pin-label'
  label.textContent = venueName

  el.appendChild(num)
  el.appendChild(label)
  // The whole label is the accessible name, in the form the brief asks for.
  el.setAttribute('aria-label', `${position}. ${venueName}`)
  return el
}

export default function CrawlBuilder({
  crawl,
  initialStops,
}: {
  crawl: Crawl
  /** The saved stops, in order, as the server read them. */
  initialStops: CrawlStopDetail[]
}) {
  const router = useRouter()

  const initialIds = useMemo(() => initialStops.map((s) => s.exhibition_id), [initialStops])

  const [title, setTitle] = useState(crawl.title)
  const [savedTitle, setSavedTitle] = useState(crawl.title)
  const [status, setStatus] = useState<CrawlStatus>(crawl.status)

  const [stops, setStops] = useState<string[]>(initialIds)
  const [saved, setSaved] = useState<string[]>(initialIds)

  const [candidates, setCandidates] = useState<MapExhibition[]>([])
  const [loadingCandidates, setLoadingCandidates] = useState(true)
  const [filter, setFilter] = useState('')

  /**
   * The last route the API answered with.
   *
   * `route` below is DERIVED from it rather than this being cleared directly,
   * because "fewer than two placeable stops" is not a route that was fetched
   * and emptied — it is a route that does not exist. Writing an empty one into
   * state to say so would be state describing the absence of state, and React
   * flags exactly that (setState inside an effect body) as the cascading
   * render it is.
   */
  const [routeData, setRouteData] = useState<CrawlRoute | null>(null)
  const [routeLoading, setRouteLoading] = useState(false)
  /** True once the style has loaded and the route source and layers exist. */
  const [mapReady, setMapReady] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const dragIdxRef = useRef<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  // Set once the first route has been drawn, so the map does not yank itself
  // back to the whole route every time somebody nudges a stop.
  const fittedRef = useRef(false)

  const dirty =
    stops.length !== saved.length || stops.some((id, i) => id !== saved[i])

  // ── Where a stop's details come from ─────────────────────────────────────

  const savedDetail = useMemo(
    () => new Map(initialStops.map((s) => [s.exhibition_id, s])),
    [initialStops]
  )
  const candidateById = useMemo(
    () => new Map(candidates.map((c) => [c.id, c])),
    [candidates]
  )

  const info = useCallback(
    (id: string): StopInfo => {
      const saved = savedDetail.get(id)
      if (saved) {
        return {
          title: saved.show_title,
          venue_name: saved.venue_name,
          lat: saved.lat,
          lng: saved.lng,
          end_date: saved.end_date,
          on_view: saved.on_view,
        }
      }
      const c = candidateById.get(id)
      if (c) {
        return {
          title: c.show_title,
          venue_name: c.institution_name,
          lat: c.venue_lat,
          lng: c.venue_lng,
          end_date: c.end_date,
          // Everything the candidate feed offers is currently on view — that is
          // what /api/map-exhibitions selects.
          on_view: true,
        }
      }
      // Added in this session from a list that has since been refetched, or a
      // show pulled while the page was open. It keeps its slot and can be
      // removed; it cannot be drawn.
      return {
        title: 'This show is no longer listed',
        venue_name: '',
        lat: null,
        lng: null,
        end_date: null,
        on_view: false,
      }
    },
    [savedDetail, candidateById]
  )

  // ── The pickable shows ───────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/map-exhibitions')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: MapExhibition[]) => {
        setCandidates(data)
        setLoadingCandidates(false)
      })
      .catch(() => setLoadingCandidates(false))
  }, [])

  const available = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return candidates
      .filter((c) => !stops.includes(c.id))
      .filter(
        (c) =>
          !q ||
          c.show_title.toLowerCase().includes(q) ||
          c.institution_name.toLowerCase().includes(q) ||
          c.artists.some((a) => a.toLowerCase().includes(q))
      )
      // The picker is a list somebody scans, not a catalogue. Without a cap it
      // renders every open show in New York on a page that already holds a map.
      .slice(0, 60)
  }, [candidates, stops, filter])

  // ── The map ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapContainerRef.current) return
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAPBOX_STYLE,
      center: [-73.97, 40.72],
      zoom: 11,
    })
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left')

    map.on('load', () => {
      map.addSource('crawl-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      // TWO LAYERS OVER ONE SOURCE, filtered on the same property the API sets.
      // A real walking leg and a guessed straight line must not look alike: the
      // whole point of the per-leg fallback is that it is visible.
      map.addLayer({
        id: 'crawl-route-walking',
        type: 'line',
        source: 'crawl-route',
        filter: ['==', ['get', 'mode'], 'walking'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // Yellow, not the pin blue. The project's style is dark navy and
        // #3432A8 on it is very nearly invisible; --yellow is the palette's
        // other ink and reads at a glance against that ground.
        paint: { 'line-color': '#E2CE3A', 'line-width': 4, 'line-opacity': 0.95 },
      })

      map.addLayer({
        id: 'crawl-route-straight',
        type: 'line',
        source: 'crawl-route',
        filter: ['==', ['get', 'mode'], 'straight'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // The same yellow, dashed and dimmer. Same colour because it is the
        // same route; dashed because this leg is a guess — see the API route.
        paint: {
          'line-color': '#E2CE3A',
          'line-width': 3,
          'line-opacity': 0.65,
          'line-dasharray': [1.5, 2],
        },
      })

      // The draw effect below waits on this. A crawl's stops arrive before the
      // style finishes loading — the ordinary case on a page that
      // server-renders them — so the first draw has to be triggered from here
      // rather than from the data, which was already there.
      setMapReady(true)
    })

    mapRef.current = map
    return () => {
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      setMapReady(false)
      map.remove()
      mapRef.current = null
    }
  }, [])

  // ── The route line, redrawn as the draft changes ─────────────────────────

  // Only stops that can be placed take part. A stop with no coordinates is
  // skipped rather than routed through (0, 0) in the Atlantic, and the legs
  // either side of it join up — the numbering in the list still shows it.
  const placeable = useMemo(() => {
    return stops
      .map((id, index) => {
        const s = info(id)
        return s.lat != null && s.lng != null ? { index, lat: s.lat, lng: s.lng } : null
      })
      .filter((p): p is { index: number; lat: number; lng: number } => p !== null)
  }, [stops, info])

  const placeableKey = useMemo(
    () => placeable.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join('|'),
    [placeable]
  )

  useEffect(() => {
    // Nothing to ask for. `route` reads as empty on its own — see routeData.
    if (placeable.length < 2) return

    // Debounced: dragging a stop through three slots should ask for one route,
    // not three. The abort matters as much as the delay — an earlier request
    // that lands late would otherwise draw an order nobody is looking at.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setRouteLoading(true)
      fetch('/api/crawl-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: placeable.map((p) => ({ index: p.index, lng: p.lng, lat: p.lat })),
        }),
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : { segments: [], fallback_count: 0 }))
        .then((data: CrawlRoute) => {
          setRouteData(data)
          setRouteLoading(false)
        })
        .catch((e) => {
          if (e?.name === 'AbortError') return
          setRouteData({ segments: [], fallback_count: 0 })
          setRouteLoading(false)
        })
    }, 350)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // placeableKey rather than `placeable`: a new array with the same
    // coordinates in the same order is the same route, and re-requesting it on
    // every render would be a request per keystroke in the filter box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeableKey])

  /**
   * The route as it should be drawn right now.
   *
   * Empty while there are fewer than two placeable stops, so removing the
   * second-to-last stop erases the line immediately instead of leaving the
   * previous answer on the map until a fetch that will never happen returns.
   */
  const route: CrawlRoute | null = useMemo(
    () => (placeable.length < 2 ? { segments: [], fallback_count: 0 } : routeData),
    [placeable.length, routeData]
  )

  // Draw the line.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const source = map.getSource('crawl-route') as mapboxgl.GeoJSONSource | undefined
    if (!source) return

    source.setData({
      type: 'FeatureCollection',
      features: (route?.segments ?? []).map((seg) => ({
        type: 'Feature' as const,
        properties: { mode: seg.mode },
        geometry: { type: 'LineString' as const, coordinates: seg.geometry },
      })),
    })
  }, [route, mapReady])

  // Draw the pins.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    stops.forEach((id, i) => {
      const s = info(id)
      if (s.lat == null || s.lng == null) return
      const el = createStopMarkerEl(i + 1, s.venue_name || s.title, !s.on_view)
      const marker = new mapboxgl.Marker({ element: el, anchor: 'left' })
        .setLngLat([s.lng, s.lat])
        .addTo(map)
      markersRef.current.push(marker)
    })
  }, [stops, info])

  // Frame the route once, when there is one. Re-framing on every change would
  // fight somebody who has zoomed in to look at a corner of it.
  useEffect(() => {
    const map = mapRef.current
    if (!map || fittedRef.current || placeable.length === 0) return
    const bounds = new mapboxgl.LngLatBounds()
    placeable.forEach((p) => bounds.extend([p.lng, p.lat]))
    map.fitBounds(bounds, { padding: 70, maxZoom: 15, duration: 0 })
    fittedRef.current = true
  }, [placeable])

  // ── Editing the draft ────────────────────────────────────────────────────

  function move(from: number, to: number) {
    if (to < 0 || to >= stops.length) return
    const next = [...stops]
    // Lift and reinsert, which is a swap for neighbours and stays correct for a
    // drag that crosses several slots.
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setStops(next)
  }

  function add(id: string) {
    if (stops.includes(id) || stops.length >= CRAWL_MAX_STOPS) return
    setStops([...stops, id])
  }

  function remove(id: string) {
    setStops(stops.filter((s) => s !== id))
  }

  function handleDragStart(i: number) {
    dragIdxRef.current = i
  }
  function handleDragOver(e: React.DragEvent, i: number) {
    e.preventDefault()
    setDragOverIdx(i)
  }
  function handleDrop(e: React.DragEvent, i: number) {
    e.preventDefault()
    const from = dragIdxRef.current
    if (from !== null && from !== i) move(from, i)
    dragIdxRef.current = null
    setDragOverIdx(null)
  }
  function handleDragEnd() {
    dragIdxRef.current = null
    setDragOverIdx(null)
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  async function saveStops() {
    setBusy(true)
    setError(null)
    setNotice(null)

    const { error } = await saveCrawlStops(getSupabaseBrowser(), crawl.id, stops)
    setBusy(false)

    if (error) {
      // Deliberately keeps the draft. The person may be able to fix it by
      // removing the offending stop, and throwing the arrangement away would be
      // a second loss on top of the failure.
      setError(error.message)
      return
    }

    setSaved(stops)
    setNotice('Saved.')
    // Re-read rather than patch local state: the stop details come from the
    // server, and asking again is more honest than predicting what was written.
    router.refresh()
  }

  async function saveTitle() {
    const next = title.trim()
    if (!next || next === savedTitle) {
      setTitle(savedTitle)
      return
    }
    setBusy(true)
    setError(null)
    const { error } = await renameCrawl(getSupabaseBrowser(), crawl.id, next)
    setBusy(false)
    if (error) {
      setError(error.message)
      setTitle(savedTitle)
      return
    }
    setSavedTitle(next)
    router.refresh()
  }

  async function toggleStatus() {
    const next: CrawlStatus = status === 'draft' ? 'planned' : 'draft'
    setBusy(true)
    setError(null)
    const { error } = await setCrawlStatus(getSupabaseBrowser(), crawl.id, next)
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setStatus(next)
    router.refresh()
  }

  async function removeCrawl() {
    // A crawl is somebody's arrangement of an afternoon and the delete cascades
    // to its stops, so it asks. There is no undo behind this.
    if (!window.confirm('Delete this crawl? This cannot be undone.')) return
    setBusy(true)
    const { error } = await deleteCrawl(getSupabaseBrowser(), crawl.id)
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    router.push('/crawls')
    router.refresh()
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const today = todayStr()
  const full = stops.length >= CRAWL_MAX_STOPS
  const fallbacks = route?.fallback_count ?? 0

  const walkingMinutes = (route?.segments ?? []).reduce(
    (sum, s) => sum + (s.duration_minutes ?? 0),
    0
  )

  return (
    <div className="cb-body">
      {/* Left: the map */}
      <div className="cb-map-panel">
        <div className="cb-map-wrap">
          <div ref={mapContainerRef} className="cb-map" />
          {stops.length === 0 && (
            <div className="cb-map-overlay">
              Add a stop and the walking route appears here.
            </div>
          )}
        </div>

        <div className="cb-route-summary">
          {routeLoading ? (
            <span className="cb-route-note">Working out the walk&hellip;</span>
          ) : placeable.length < 2 ? (
            <span className="cb-route-note">
              {stops.length === 0
                ? 'No stops yet.'
                : 'Add a second stop to draw the route.'}
            </span>
          ) : (
            <>
              <span className="cb-route-stat">
                {stops.length} stop{stops.length === 1 ? '' : 's'}
              </span>
              {walkingMinutes > 0 && (
                <span className="cb-route-stat">{walkingMinutes} min walking</span>
              )}
              {fallbacks > 0 && (
                // Said plainly rather than hidden. A dashed leg is a straight
                // line because no walking route came back for it, and the
                // walking total above does not include it.
                <span className="cb-route-warning">
                  {fallbacks} leg{fallbacks === 1 ? '' : 's'} shown as a straight
                  line — no walking directions available
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right: the stops and the picker */}
      <div className="cb-panel">
        <div className="cb-head">
          <input
            className="cb-title-input"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setTitle(savedTitle)
            }}
            aria-label="Crawl name"
            disabled={busy}
          />
          <div className="cb-head-actions">
            <button
              type="button"
              className="cb-status"
              onClick={toggleStatus}
              disabled={busy}
            >
              {status === 'draft' ? 'Draft' : 'Planned'}
            </button>
            <button
              type="button"
              className="cb-delete"
              onClick={removeCrawl}
              disabled={busy}
            >
              Delete
            </button>
          </div>
        </div>

        <p className="cb-privacy">
          Only you can see this crawl.
        </p>

        <div className="cb-stops-head">
          <h2 className="cb-section-title">Stops</h2>
          <span className="cb-count">
            {stops.length} of {CRAWL_MAX_STOPS}
          </span>
        </div>

        {stops.length === 0 ? (
          <p className="cb-empty">
            Nothing here yet. Pick shows below and they become stops in the order
            you add them.
          </p>
        ) : (
          <ol className="cb-stops">
            {stops.map((id, i) => {
              const s = info(id)
              const closed = !s.on_view
              const unplaced = s.lat == null || s.lng == null
              const ends = formatEnd(s.end_date)
              return (
                <li
                  key={id}
                  className={`cb-stop${dragOverIdx === i ? ' cb-stop--drag-over' : ''}${closed ? ' cb-stop--closed' : ''}`}
                  draggable={!busy}
                  onDragStart={() => handleDragStart(i)}
                  onDragOver={(e) => handleDragOver(e, i)}
                  onDrop={(e) => handleDrop(e, i)}
                  onDragEnd={handleDragEnd}
                >
                  <span className="cb-stop-drag" aria-hidden="true">⠿</span>
                  <span className="cb-stop-num">{i + 1}</span>
                  <span className="cb-stop-text">
                    <span className="cb-stop-venue">{s.venue_name || '—'}</span>
                    <Link href={`/exhibitions/${id}`} className="cb-stop-title">
                      {s.title}
                    </Link>
                    {closed ? (
                      <span className="cb-stop-flag">
                        This show has closed{ends ? ` — ended ${ends}` : ''}
                      </span>
                    ) : unplaced ? (
                      <span className="cb-stop-flag">
                        No address for this show, so it is not on the map
                      </span>
                    ) : (
                      ends &&
                      s.end_date! >= today && (
                        <span className="cb-stop-ends">Until {ends}</span>
                      )
                    )}
                  </span>
                  <span className="cb-stop-actions">
                    <button
                      type="button"
                      className="cb-move"
                      onClick={() => move(i, i - 1)}
                      disabled={i === 0 || busy}
                      aria-label={`Move ${s.venue_name || s.title} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="cb-move"
                      onClick={() => move(i, i + 1)}
                      disabled={i === stops.length - 1 || busy}
                      aria-label={`Move ${s.venue_name || s.title} down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="cb-move cb-move--drop"
                      onClick={() => remove(id)}
                      disabled={busy}
                      aria-label={`Remove ${s.venue_name || s.title}`}
                    >
                      ✕
                    </button>
                  </span>
                </li>
              )
            })}
          </ol>
        )}

        {error && <p className="cb-error">{error}</p>}

        <div className="cb-save-row">
          <button
            type="button"
            className="cb-save"
            onClick={saveStops}
            disabled={!dirty || busy}
          >
            {busy ? 'Saving…' : dirty ? 'Save stops' : 'Saved'}
          </button>
          {dirty && !busy && (
            <span className="cb-unsaved">Unsaved changes</span>
          )}
          {!dirty && notice && <span className="cb-notice">{notice}</span>}
        </div>

        <div className="cb-pick">
          <h2 className="cb-section-title">Add a stop</h2>
          <input
            className="cb-filter"
            type="search"
            value={filter}
            placeholder="Search shows, galleries, artists"
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Search shows to add"
          />

          {full && (
            <p className="cb-empty">
              That is {CRAWL_MAX_STOPS} stops. Remove one to add another.
            </p>
          )}

          {loadingCandidates ? (
            <p className="cb-empty">Loading shows&hellip;</p>
          ) : available.length === 0 ? (
            <p className="cb-empty">
              {filter.trim() ? 'Nothing matches that.' : 'No shows to add.'}
            </p>
          ) : (
            <ul className="cb-available">
              {available.map((c) => (
                <li key={c.id} className="cb-available-row">
                  <span className="cb-stop-text">
                    <span className="cb-stop-venue">{c.institution_name}</span>
                    <span className="cb-stop-title">{c.show_title}</span>
                  </span>
                  <button
                    type="button"
                    className="cb-add"
                    onClick={() => add(c.id)}
                    disabled={full || busy}
                    aria-label={`Add ${c.show_title} at ${c.institution_name}`}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
