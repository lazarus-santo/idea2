'use client'

import { useEffect, useRef, useState, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { MapExhibition, VenueHours, ItineraryStop, DirectionLeg } from '@/lib/types'
import ExhibitionFilters from './ExhibitionFilters'
import { createPrimaryMarkerEl } from '@/lib/mapMarkers'
import { buildPopupCard, formatArtists, formatEndDate, type PopupCardItem } from '@/lib/mapPopup'

// ── Holiday detection ──────────────────────────────────────────────────────────

function getNthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const d = new Date(year, month, 1)
  const offset = (weekday - d.getDay() + 7) % 7
  d.setDate(1 + offset + (n - 1) * 7)
  return d
}

function getLastMonday(year: number, month: number): Date {
  const d = new Date(year, month + 1, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

function getHolidayName(date: Date): string | null {
  const y = date.getFullYear()
  const m = date.getMonth()
  const d = date.getDate()

  const thanksgiving = getNthWeekday(y, 10, 4, 4)
  const tWkStart = new Date(thanksgiving)
  tWkStart.setDate(thanksgiving.getDate() - ((thanksgiving.getDay() + 6) % 7))
  const tWkEnd = new Date(tWkStart)
  tWkEnd.setDate(tWkStart.getDate() + 6)
  if (date >= tWkStart && date <= tWkEnd) {
    if (d === thanksgiving.getDate() && m === 10) return 'Thanksgiving'
    return 'Thanksgiving week'
  }

  if (m === 11 && d >= 24) return d === 25 ? 'Christmas' : 'Holiday season'
  if (m === 0 && d === 1) return "New Year's Day"

  const mmdd = `${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const fixed: Record<string, string> = {
    '01-01': "New Year's Day",
    '06-19': 'Juneteenth',
    '07-04': 'Independence Day',
    '11-11': "Veterans' Day",
    '12-25': 'Christmas',
  }
  if (fixed[mmdd]) return fixed[mmdd]

  const mlk = getNthWeekday(y, 0, 1, 3)
  if (m === 0 && d === mlk.getDate()) return 'Martin Luther King Jr. Day'

  const presidents = getNthWeekday(y, 1, 1, 3)
  if (m === 1 && d === presidents.getDate()) return "Presidents' Day"

  const memorial = getLastMonday(y, 4)
  if (m === 4 && d === memorial.getDate()) return 'Memorial Day'

  const labor = getNthWeekday(y, 8, 1, 1)
  if (m === 8 && d === labor.getDate()) return 'Labor Day'

  const columbus = getNthWeekday(y, 9, 1, 2)
  if (m === 9 && d === columbus.getDate()) return 'Columbus Day'

  return null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function isVenueOpen(hours: VenueHours | null, dateStr: string, timeStr: string): boolean {
  if (!hours) return true
  const date = new Date(dateStr + 'T00:00:00')
  const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const range = hours[dayKeys[date.getDay()] as keyof VenueHours]
  if (!range) return false
  return timeStr >= range[0] && timeStr < range[1]
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function timeStrToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function minutesToTimeStr(mins: number): string {
  const h = Math.floor(mins / 60) % 24
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatTime12h(timeStr: string): string {
  const [h, m] = timeStr.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 || 12
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`
}

function formatDateDisplay(dateStr: string): string {
  const [y, mo, d] = dateStr.split('-').map(Number)
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function nowTimeStr(): string {
  const h = new Date().getHours()
  return `${String(h).padStart(2, '0')}:00`
}

function defaultEndTime(): string {
  const h = Math.min(new Date().getHours() + 3, 23)
  return `${String(h).padStart(2, '0')}:00`
}

// ── Icons ──────────────────────────────────────────────────────────────────────

function WalkIcon() {
  return (
    <svg width="13" height="17" viewBox="0 0 13 17" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="6.5" cy="2" r="1.5" fill="currentColor" />
      <line x1="6.5" y1="3.5" x2="5.5" y2="9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="3.5" y1="6" x2="8.5" y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="5.5" y1="9" x2="3" y2="16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="5.5" y1="9" x2="9" y2="15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function DriveIcon() {
  return (
    <svg width="20" height="13" viewBox="0 0 20 13" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4 5.5L6 2h8l2 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <rect x="1" y="5.5" width="18" height="5.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5" cy="11" r="2" fill="currentColor" />
      <circle cx="15" cy="11" r="2" fill="currentColor" />
    </svg>
  )
}

// ── Calendar picker ────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfWeek(year: number, month: number): number {
  const day = new Date(year, month, 1).getDay()
  return (day + 6) % 7 // Mon=0 … Sun=6
}

function CalendarPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(value)
  const [viewYear, setViewYear] = useState(() => parseInt(value.split('-')[0]))
  const [viewMonth, setViewMonth] = useState(() => parseInt(value.split('-')[1]) - 1)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  function openPicker() {
    setPending(value)
    const [y, m] = value.split('-').map(Number)
    setViewYear(y)
    setViewMonth(m - 1)
    setOpen(true)
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) }
    else setViewMonth(m => m - 1)
  }

  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) }
    else setViewMonth(m => m + 1)
  }

  const today = todayStr()
  const firstDow = getFirstDayOfWeek(viewYear, viewMonth)
  const daysInMonth = getDaysInMonth(viewYear, viewMonth)
  const daysInPrevMonth = getDaysInMonth(viewYear, viewMonth === 0 ? 11 : viewMonth - 1)

  type Cell = { dateStr: string; day: number; isCurrentMonth: boolean }
  const cells: Cell[] = []

  for (let i = 0; i < firstDow; i++) {
    const d = daysInPrevMonth - firstDow + 1 + i
    const mo = viewMonth === 0 ? 11 : viewMonth - 1
    const y = viewMonth === 0 ? viewYear - 1 : viewYear
    cells.push({ dateStr: `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, day: d, isCurrentMonth: false })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({
      dateStr: `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      day: d,
      isCurrentMonth: true,
    })
  }
  let nextDay = 1
  while (cells.length % 7 !== 0) {
    const mo = viewMonth === 11 ? 0 : viewMonth + 1
    const y = viewMonth === 11 ? viewYear + 1 : viewYear
    cells.push({ dateStr: `${y}-${String(mo + 1).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`, day: nextDay++, isCurrentMonth: false })
  }

  return (
    <div className="mp-picker-wrap" ref={wrapRef}>
      <button className="mp-picker-trigger" onClick={openPicker} type="button">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="1" y="2.5" width="12" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
          <line x1="1" y1="5.5" x2="13" y2="5.5" stroke="currentColor" strokeWidth="1.25" />
          <line x1="4.5" y1="1" x2="4.5" y2="4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          <line x1="9.5" y1="1" x2="9.5" y2="4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
        <span>{formatDateDisplay(value)}</span>
      </button>

      {open && (
        <div className="mp-picker-popover">
          <div className="mp-cal-header">
            <button className="mp-cal-nav" onClick={prevMonth} type="button">‹</button>
            <span className="mp-cal-month-label">{MONTHS[viewMonth]} {viewYear}</span>
            <button className="mp-cal-nav" onClick={nextMonth} type="button">›</button>
          </div>
          <div className="mp-cal-grid">
            {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => (
              <span key={d} className="mp-cal-dow">{d}</span>
            ))}
            {cells.map((cell, i) => {
              const cls = [
                'mp-cal-day',
                !cell.isCurrentMonth ? 'mp-cal-day--other' : '',
                cell.dateStr === pending ? 'mp-cal-day--selected' : '',
                cell.dateStr === today && cell.isCurrentMonth ? 'mp-cal-day--today' : '',
              ].filter(Boolean).join(' ')
              return (
                <button
                  key={i}
                  type="button"
                  className={cls}
                  tabIndex={cell.isCurrentMonth ? 0 : -1}
                  onClick={() => { if (cell.isCurrentMonth) setPending(cell.dateStr) }}
                >
                  {cell.day}
                </button>
              )
            })}
          </div>
          <div className="mp-picker-footer">
            <button type="button" className="mp-picker-cancel" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="mp-picker-apply" onClick={() => { onChange(pending); setOpen(false) }}>Apply</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Time picker ────────────────────────────────────────────────────────────────

function TimePicker({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(value)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  return (
    <div className="mp-picker-wrap" ref={wrapRef}>
      <button className="mp-picker-trigger" onClick={() => { setPending(value); setOpen(o => !o) }} type="button">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.25" />
          <line x1="6.5" y1="3.5" x2="6.5" y2="6.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          <line x1="6.5" y1="6.5" x2="9" y2="8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
        <span>{formatTime12h(value)}</span>
      </button>

      {open && (
        <div className="mp-picker-popover mp-picker-popover--time">
          <p className="mp-time-label">{label}</p>
          <input
            type="time"
            className="mp-time-native"
            value={pending}
            onChange={e => setPending(e.target.value)}
          />
          <div className="mp-picker-footer">
            <button type="button" className="mp-picker-cancel" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="mp-picker-apply" onClick={() => { onChange(pending); setOpen(false) }}>Apply</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const MAPBOX_STYLE = 'mapbox://styles/santolazarus/cmq35s95r002h01qlhnj88ivd'
type VenueFilter = 'all' | 'museum' | 'gallery' | 'fair'
type SubFilter = 'closing-soon' | 'opening-soon' | null
const FILTER_TABS: { label: string; value: VenueFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Museums', value: 'museum' },
  { label: 'Galleries', value: 'gallery' },
  { label: 'Fairs', value: 'fair' },
]

function isClosingSoon(ex: MapExhibition): boolean {
  if (!ex.end_date) return false
  const now = Date.now()
  const diff = (new Date(ex.end_date + 'T00:00:00').getTime() - now) / 86400000
  if (ex.venue_type === 'fair') {
    const isLive = ex.start_date ? new Date(ex.start_date + 'T00:00:00').getTime() <= now : true
    return isLive && diff >= 0 && diff <= 7
  }
  return diff >= 0 && diff <= 7
}

function isOpeningSoon(ex: MapExhibition): boolean {
  if (!ex.start_date) return false
  const diff = (new Date(ex.start_date + 'T00:00:00').getTime() - Date.now()) / 86400000
  return diff >= 0 && diff <= 7
}

export default function StandaloneMap() {
  const searchParams = useSearchParams()
  const deepLinkId = searchParams.get('add')

  const [exhibitions, setExhibitions] = useState<MapExhibition[]>([])
  const [loading, setLoading] = useState(true)
  const [venueFilter, setVenueFilter] = useState<VenueFilter>('all')
  const [subFilter, setSubFilter] = useState<SubFilter>(null)

  const [selectedDate, setSelectedDate] = useState(todayStr)
  const [windowStart, setWindowStart] = useState(nowTimeStr)
  const [windowEnd, setWindowEnd] = useState(defaultEndTime)

  const [itinerary, setItinerary] = useState<ItineraryStop[]>([])
  const [legs, setLegs] = useState<DirectionLeg[]>([])
  const [legsLoading, setLegsLoading] = useState(false)
  const [legModes, setLegModes] = useState<('walking' | 'driving')[]>([])

  const [isMobile, setIsMobile] = useState(false)
  const [mobileSelected, setMobileSelected] = useState<MapExhibition[] | null>(null)

  // Drag-and-drop state
  const dragIdxRef = useRef<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<Array<{ marker: mapboxgl.Marker; id: string }>>([])
  const activePopupRef = useRef<mapboxgl.Popup | null>(null)

  const addToItineraryRef = useRef((ex: MapExhibition) => {
    setItinerary(prev =>
      prev.some(s => s.exhibitionId === ex.id)
        ? prev
        : [...prev, { exhibitionId: ex.id, exhibition: ex, minutesAtVenue: 15 }]
    )
  })

  const openMobileDrawerRef = useRef((exs: MapExhibition[]) => setMobileSelected(exs))

  // Sync legModes length whenever itinerary length changes
  useEffect(() => {
    setLegModes(prev => {
      const needed = Math.max(0, itinerary.length - 1)
      if (prev.length === needed) return prev
      if (prev.length < needed) {
        return [...prev, ...(Array(needed - prev.length).fill('walking') as ('walking' | 'driving')[])]
      }
      return prev.slice(0, needed)
    })
  }, [itinerary.length])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    fetch('/api/map-exhibitions')
      .then(r => r.json())
      .then((data: MapExhibition[]) => { setExhibitions(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!deepLinkId || !exhibitions.length) return
    const ex = exhibitions.find(e => e.id === deepLinkId)
    if (ex) addToItineraryRef.current(ex)
  }, [deepLinkId, exhibitions])

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
    mapRef.current = map
    return () => {
      markersRef.current.forEach(({ marker }) => marker.remove())
      markersRef.current = []
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !exhibitions.length) return

    activePopupRef.current?.remove()
    activePopupRef.current = null

    markersRef.current.forEach(({ marker }) => marker.remove())
    markersRef.current = []

    let visible = venueFilter === 'all'
      ? exhibitions
      : exhibitions.filter(ex => ex.venue_type === venueFilter)
    if (subFilter === 'closing-soon') visible = visible.filter(isClosingSoon)
    if (subFilter === 'opening-soon') visible = visible.filter(isOpeningSoon)

    // Group by venue only to detect co-located exhibitions for jitter
    const byVenue = new Map<string, MapExhibition[]>()
    visible.forEach(ex => {
      if (!ex.venue_lat || !ex.venue_lng) return
      const arr = byVenue.get(ex.venue_id) ?? []
      arr.push(ex)
      byVenue.set(ex.venue_id, arr)
    })

    byVenue.forEach(shows => {
      const primary = shows[0]
      const lat = primary.venue_lat!
      const lng = primary.venue_lng!
      const open = isVenueOpen(primary.venue_hours, selectedDate, windowStart)

      const el = createPrimaryMarkerEl(!open)
      const marker = new mapboxgl.Marker(el).setLngLat([lng, lat])

      if (isMobile) {
        el.addEventListener('click', () => openMobileDrawerRef.current(shows))
        marker.addTo(map)
      } else {
        const items: PopupCardItem[] = shows.map(ex => ({
          title: ex.show_title,
          subtitle: ex.artists.length ? formatArtists(ex.artists) : undefined,
          meta: ex.venue_name,
          dateLabel: ex.end_date ? `Until ${formatEndDate(ex.end_date)}` : undefined,
          imageUrl: ex.image_url,
          href: `/exhibitions/${ex.id}`,
          addAction: {
            onClick: () => { addToItineraryRef.current(ex); popup.remove() },
          },
        }))

        const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: '375px' })
        popup.setDOMContent(buildPopupCard(items))

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

        el.addEventListener('mouseenter', () => { pinOver = true; cancelClose() })
        el.addEventListener('mouseleave', () => { pinOver = false; scheduleClose() })

        el.addEventListener('click', () => {
          if (activePopupRef.current && activePopupRef.current !== popup) {
            activePopupRef.current.remove()
          }
          if (!popup.isOpen()) {
            popup.setLngLat([lng, lat]).addTo(map)
            activePopupRef.current = popup
          }
        })

        popup.on('open', () => {
          const popupEl = popup.getElement()
          if (!popupEl) return
          popupEl.addEventListener('mouseenter', () => { popupOver = true; cancelClose() })
          popupEl.addEventListener('mouseleave', () => { popupOver = false; scheduleClose() })
        })

        popup.on('close', () => {
          if (activePopupRef.current === popup) activePopupRef.current = null
        })

        marker.addTo(map)
      }

      markersRef.current.push({ marker, id: primary.id })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exhibitions, venueFilter, subFilter, selectedDate, windowStart, isMobile])

  useEffect(() => {
    if (itinerary.length < 2) { setLegs([]); return }

    let cancelled = false
    setLegsLoading(true)

    Promise.all(
      itinerary.slice(0, -1).map((stop, i) => {
        const next = itinerary[i + 1]
        if (!stop.exhibition.venue_lng || !stop.exhibition.venue_lat ||
            !next.exhibition.venue_lng || !next.exhibition.venue_lat) {
          return Promise.resolve<DirectionLeg>({ walkingMinutes: null, drivingMinutes: null })
        }
        return fetch('/api/directions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            origin: [stop.exhibition.venue_lng, stop.exhibition.venue_lat],
            destination: [next.exhibition.venue_lng, next.exhibition.venue_lat],
          }),
        }).then(r => r.ok ? r.json() : { walkingMinutes: null, drivingMinutes: null })
      })
    ).then(newLegs => {
      if (!cancelled) { setLegs(newLegs as DirectionLeg[]); setLegsLoading(false) }
    }).catch(() => { if (!cancelled) setLegsLoading(false) })

    return () => { cancelled = true }
  }, [itinerary])

  // ── Itinerary mutations ──────────────────────────────────────────────────────

  function removeStop(idx: number) {
    setItinerary(prev => prev.filter((_, i) => i !== idx))
    // Remove the leg going into this stop (or out of it if first stop)
    setLegModes(prev => prev.filter((_, i) => i !== Math.min(idx, prev.length - 1)))
  }

  function moveStop(idx: number, dir: -1 | 1) {
    const j = idx + dir
    if (j < 0 || j >= itinerary.length) return
    setItinerary(prev => {
      const arr = [...prev]
      ;[arr[idx], arr[j]] = [arr[j], arr[idx]]
      return arr
    })
  }

  function updateMinutes(idx: number, mins: number) {
    if (isNaN(mins) || mins < 1) return
    setItinerary(prev => prev.map((s, i) => i === idx ? { ...s, minutesAtVenue: mins } : s))
  }

  function setLegMode(idx: number, mode: 'walking' | 'driving') {
    setLegModes(prev => prev.map((m, i) => i === idx ? mode : m))
  }

  // Drag-and-drop handlers
  function handleDragStart(i: number) {
    dragIdxRef.current = i
  }

  function handleDragOver(e: React.DragEvent, i: number) {
    e.preventDefault()
    setDragOverIdx(i)
  }

  function handleDrop(e: React.DragEvent, toIdx: number) {
    e.preventDefault()
    const from = dragIdxRef.current
    setDragOverIdx(null)
    dragIdxRef.current = null
    if (from === null || from === toIdx) return
    setItinerary(prev => {
      const arr = [...prev]
      const [item] = arr.splice(from, 1)
      arr.splice(toIdx, 0, item)
      return arr
    })
    // legModes length stays the same; length-sync effect handles edge cases
  }

  function handleDragEnd() {
    setDragOverIdx(null)
    dragIdxRef.current = null
  }

  // ── Derived state ────────────────────────────────────────────────────────────

  const arrivalTimes = useMemo(() => {
    const times: string[] = []
    if (!itinerary.length) return times
    let cursor = timeStrToMinutes(windowStart)
    for (let i = 0; i < itinerary.length; i++) {
      times.push(minutesToTimeStr(cursor))
      cursor += itinerary[i].minutesAtVenue
      if (i < legs.length) {
        const mode = legModes[i] ?? 'walking'
        cursor += ((mode === 'walking' ? legs[i].walkingMinutes : legs[i].drivingMinutes) ?? 0)
      }
    }
    return times
  }, [itinerary, legs, legModes, windowStart])

  const totalMinutes = useMemo(() => {
    const atVenue = itinerary.reduce((sum, s) => sum + s.minutesAtVenue, 0)
    const travel = legs.reduce((sum, leg, i) => {
      const mode = legModes[i] ?? 'walking'
      return sum + ((mode === 'walking' ? leg.walkingMinutes : leg.drivingMinutes) ?? 0)
    }, 0)
    return atVenue + travel
  }, [itinerary, legs, legModes])

  const riskFlags = useMemo(() => {
    const flags: string[] = []
    if (!itinerary.length) return flags

    const startMins = timeStrToMinutes(windowStart)
    const endMins = timeStrToMinutes(windowEnd)
    const windowDuration = endMins - startMins

    if (windowDuration > 0 && totalMinutes > windowDuration) {
      flags.push(
        `This itinerary runs about ${formatMinutes(totalMinutes)}, but your window is ${formatMinutes(windowDuration)}`
      )
    }

    let cursor = startMins
    for (let i = 0; i < itinerary.length; i++) {
      if (i > 0) {
        const mode = legModes[i - 1] ?? 'walking'
        cursor += (mode === 'walking' ? legs[i - 1]?.walkingMinutes : legs[i - 1]?.drivingMinutes) ?? 0
      }
      const { exhibition } = itinerary[i]
      if (exhibition.venue_hours) {
        const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        const date = new Date(selectedDate + 'T00:00:00')
        const dayIdx = date.getDay()
        const range = exhibition.venue_hours[dayKeys[dayIdx] as keyof VenueHours]
        if (!range) {
          flags.push(`${exhibition.venue_name} is closed on ${dayNames[dayIdx]}s`)
        } else {
          const openM = timeStrToMinutes(range[0])
          const closeM = timeStrToMinutes(range[1])
          if (cursor < openM) {
            flags.push(`${exhibition.venue_name} opens at ${formatTime12h(range[0])}`)
          } else if (cursor >= closeM) {
            flags.push(`${exhibition.venue_name} closes at ${formatTime12h(range[1])}`)
          }
        }
      }
      cursor += itinerary[i].minutesAtVenue
    }

    return flags
  }, [itinerary, legs, legModes, totalMinutes, windowStart, windowEnd, selectedDate])

  const holidayName = useMemo(() => {
    return getHolidayName(new Date(selectedDate + 'T00:00:00'))
  }, [selectedDate])

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="mp-page">
      <nav style={{ position: 'relative', background: '#FFFCEC' }}>
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

      <div className="mp-body">
        {/* Left: map panel */}
        <div className="mp-map-panel">
          <div className="mp-map-controls">
            <ExhibitionFilters
              tabs={FILTER_TABS}
              activeTab={venueFilter}
              subFilter={subFilter}
              onTabChange={v => { setVenueFilter(v as VenueFilter); setSubFilter(null) }}
              onSubFilterToggle={f => setSubFilter(prev => prev === f ? null : f)}
            />
          </div>
          <div className="mp-map-wrap">
            <div ref={mapContainerRef} className="mp-map" />
            {loading && <div className="mp-map-overlay">Loading exhibitions&hellip;</div>}
          </div>
        </div>

        {/* Right: itinerary panel */}
        <div className="mp-itinerary-panel">
          {/* Date / time pickers */}
          <div className="mp-datetime-section">
            <div className="mp-datetime-row">
              <div className="mp-datetime-field">
                <label className="mp-datetime-label">Date</label>
                <CalendarPicker value={selectedDate} onChange={setSelectedDate} />
              </div>
              <div className="mp-datetime-field">
                <label className="mp-datetime-label">From</label>
                <TimePicker value={windowStart} onChange={setWindowStart} label="Start time" />
              </div>
              <div className="mp-datetime-field">
                <label className="mp-datetime-label">To</label>
                <TimePicker value={windowEnd} onChange={setWindowEnd} label="End time" />
              </div>
            </div>
            {holidayName && (
              <p className="mp-holiday-warning">
                {holidayName} — hours may vary, check the gallery&rsquo;s site or socials for more info
              </p>
            )}
          </div>

          {itinerary.length === 0 ? (
            <div className="mp-empty-state">
              <p className="mp-empty-title">Your itinerary</p>
              <p className="mp-empty-hint">add an itinerary stop by clicking onto a pin and adding it to the itinerary</p>
            </div>
          ) : (
            <>
              <div className="mp-stops">
                {itinerary.map((stop, i) => (
                  <div key={stop.exhibitionId}>
                    <div
                      className={`mp-stop${dragOverIdx === i ? ' mp-stop--drag-over' : ''}`}
                      draggable
                      onDragStart={() => handleDragStart(i)}
                      onDragOver={e => handleDragOver(e, i)}
                      onDrop={e => handleDrop(e, i)}
                      onDragEnd={handleDragEnd}
                    >
                      <div className="mp-stop-drag" aria-hidden="true">⠿</div>
                      <div className="mp-stop-main">
                        <span className="mp-stop-num">{i + 1}</span>
                        <div className="mp-stop-text">
                          {arrivalTimes[i] && (
                            <span className="mp-stop-arrive">{formatTime12h(arrivalTimes[i])}</span>
                          )}
                          <p className="mp-stop-gallery">{stop.exhibition.institution_name}</p>
                          <Link href={`/exhibitions/${stop.exhibitionId}`} className="mp-stop-title">
                            {stop.exhibition.show_title}
                          </Link>
                        </div>
                      </div>
                      <div className="mp-stop-controls">
                        <div className="mp-stop-arrows">
                          <button
                            className="mp-stop-arrow"
                            onClick={() => moveStop(i, -1)}
                            disabled={i === 0}
                            aria-label="Move up"
                          >↑</button>
                          <button
                            className="mp-stop-arrow"
                            onClick={() => moveStop(i, 1)}
                            disabled={i === itinerary.length - 1}
                            aria-label="Move down"
                          >↓</button>
                        </div>
                        <div className="mp-stop-time-row">
                          <input
                            type="number"
                            className="mp-stop-time-input"
                            value={stop.minutesAtVenue}
                            min={5}
                            max={480}
                            step={5}
                            onChange={e => updateMinutes(i, Number(e.target.value))}
                            aria-label="Minutes at venue"
                          />
                          <span className="mp-stop-time-unit">min</span>
                        </div>
                        <button className="mp-stop-remove" onClick={() => removeStop(i)} aria-label="Remove stop">×</button>
                      </div>
                    </div>

                    {i < itinerary.length - 1 && (
                      <div className="mp-leg">
                        {legsLoading ? (
                          <span className="mp-leg-loading">···</span>
                        ) : legs[i] ? (
                          <>
                            <button
                              type="button"
                              className={`mp-leg-mode-btn${(legModes[i] ?? 'walking') === 'walking' ? ' mp-leg-mode-btn--active' : ''}`}
                              onClick={() => setLegMode(i, 'walking')}
                              aria-label="Walk"
                              title={legs[i].walkingMinutes != null ? `Walk ${legs[i].walkingMinutes}m` : 'Walking'}
                            >
                              <WalkIcon />
                            </button>
                            <span className="mp-leg-time">
                              {(legModes[i] ?? 'walking') === 'walking'
                                ? (legs[i].walkingMinutes != null ? `${legs[i].walkingMinutes}m` : '—')
                                : (legs[i].drivingMinutes != null ? `${legs[i].drivingMinutes}m` : '—')
                              }
                            </span>
                            <button
                              type="button"
                              className={`mp-leg-mode-btn${legModes[i] === 'driving' ? ' mp-leg-mode-btn--active' : ''}`}
                              onClick={() => setLegMode(i, 'driving')}
                              aria-label="Drive"
                              title={legs[i].drivingMinutes != null ? `Drive ${legs[i].drivingMinutes}m` : 'Driving'}
                            >
                              <DriveIcon />
                            </button>
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {riskFlags.length > 0 && (
                <div className="mp-risk-flags">
                  {riskFlags.map((flag, i) => (
                    <p key={i} className="mp-risk-flag">{flag}</p>
                  ))}
                </div>
              )}

              <div className="mp-footer">
                Estimated total: <strong>{formatMinutes(totalMinutes)}</strong>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Mobile bottom drawer */}
      {isMobile && mobileSelected && (
        <>
          <div className="mp-drawer-backdrop" onClick={() => setMobileSelected(null)} />
          <div className="mp-drawer" role="dialog" aria-modal="true">
            <button className="mp-drawer-close" onClick={() => setMobileSelected(null)} aria-label="Close">×</button>
            {mobileSelected.length === 1 ? (
              <>
                {mobileSelected[0].image_url && (
                  <img src={mobileSelected[0].image_url} alt={mobileSelected[0].show_title} className="mp-drawer-img" />
                )}
                <div className="mp-drawer-body">
                  <p className="mp-popup-title">{mobileSelected[0].show_title}</p>
                  {mobileSelected[0].artists.length > 0 && (
                    <p className="mp-popup-artist">{mobileSelected[0].artists.join(', ')}</p>
                  )}
                  <p className="mp-popup-gallery">{mobileSelected[0].venue_name}</p>
                  {mobileSelected[0].end_date && (
                    <p className="mp-popup-date">Until {formatEndDate(mobileSelected[0].end_date)}</p>
                  )}
                  <div className="mp-popup-actions">
                    <Link href={`/exhibitions/${mobileSelected[0].id}`} className="mp-popup-view">View Show</Link>
                    <button
                      className="mp-popup-add"
                      onClick={() => { addToItineraryRef.current(mobileSelected![0]); setMobileSelected(null) }}
                    >
                      + Add to itinerary
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="mp-drawer-body">
                <p className="mp-popup-gallery mp-drawer-venue-header">{mobileSelected[0].institution_name}</p>
                {mobileSelected.map(ex => (
                  <div key={ex.id} className="mp-drawer-multi-show">
                    <p className="mp-popup-title">{ex.show_title}</p>
                    {ex.artists.length > 0 && <p className="mp-popup-artist">{ex.artists.join(', ')}</p>}
                    {ex.end_date && <p className="mp-popup-date">Until {formatEndDate(ex.end_date)}</p>}
                    <div className="mp-popup-actions">
                      <Link href={`/exhibitions/${ex.id}`} className="mp-popup-view">View Show</Link>
                      <button
                        className="mp-popup-add"
                        onClick={() => { addToItineraryRef.current(ex); setMobileSelected(null) }}
                      >
                        + Add to itinerary
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

