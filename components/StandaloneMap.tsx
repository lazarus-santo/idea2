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
import { VENUE_TABS, TAB_LABEL, tabMatches, type VenueTab } from '@/lib/institution-types'
import { groupByPlace } from '@/lib/exhibition-location'
import AccountNav from '@/components/account/AccountNav'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import {
  createCrawl,
  deleteCrawl,
  renameCrawl,
  saveCrawlStops,
  // Aliased: `setCrawlStatus` is also this component's state setter, and the
  // two would silently shadow each other.
  setCrawlStatus as writeCrawlStatus,
} from '@/lib/crawl-writes'
import {
  CRAWL_MAX_STOPS,
  type CrawlRoute,
  type CrawlStatus,
  type CrawlStopDetail,
} from '@/lib/crawl-types'

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

// ── Crawl stop pins ────────────────────────────────────────────────────────────

/**
 * The pin drawn at an itinerary stop: its number and the venue's name, on the
 * map itself — "1. Gagosian".
 *
 * A DOM element handed to a Mapbox Marker, not a symbol layer. A symbol layer
 * hides labels that collide, which is exactly wrong here: two galleries on the
 * same block is the normal case in Chelsea, and a route whose stop 4 is
 * invisible because stop 3 is next door is a route you cannot read. Markers
 * always draw. They can overlap, which is legible; they cannot silently
 * disappear, which is not.
 *
 * Drawn ON TOP of the ordinary pin already at that point rather than replacing
 * it — see the crawl marker effect for why the two layers are kept apart.
 */
function createCrawlStopEl(position: number, venueName: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'mp-crawl-pin'

  const num = document.createElement('span')
  num.className = 'mp-crawl-pin-num'
  num.textContent = String(position)

  const label = document.createElement('span')
  label.className = 'mp-crawl-pin-label'
  label.textContent = venueName

  el.appendChild(num)
  el.appendChild(label)
  // The whole thing is the accessible name, in the form the brief asks for.
  el.setAttribute('aria-label', `${position}. ${venueName}`)
  return el
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

/**
 * The route line's colour: the pin blue, reused rather than re-picked.
 *
 * The same value createPrimaryMarkerEl() fills a pin with in lib/mapMarkers.ts
 * and the same one .mp-crawl-pin-num uses for a stop's numbered badge. Written
 * here as a constant because a Mapbox paint property cannot read a CSS
 * variable, so the alternative is the literal appearing twice in this file with
 * nothing to say the two are meant to match.
 */
const ROUTE_BLUE = '#3432A8'

/**
 * The casing drawn under the route line, so the blue reads against the map.
 *
 * The same cream createPrimaryMarkerEl() puts around a pin in lib/mapMarkers.ts
 * and .mp-crawl-pin-num repeats on a stop's badge — this map's style is dark
 * navy, and a dark blue on it needs a light edge to separate it from the
 * ground. The pins already solved this; the line now solves it the same way,
 * which is what keeps the two reading as one object rather than two decisions.
 */
const ROUTE_CASING = '#FFFCEC'
type VenueFilter = 'all' | VenueTab
type SubFilter = 'closing-soon' | null
const FILTER_TABS: { label: string; value: VenueFilter }[] = [
  { label: 'All', value: 'all' },
  ...VENUE_TABS.map(t => ({ label: TAB_LABEL[t], value: t as VenueFilter })),
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

export default function StandaloneMap() {
  const searchParams = useSearchParams()
  const deepLinkId = searchParams.get('add')
  /**
   * ?crawl=<id> — a saved crawl, opened from its owner's profile.
   *
   * A query parameter rather than a route of its own, because this IS the
   * builder now: opening a saved crawl and starting a new one are the same
   * screen with the itinerary pre-filled or empty. The retired /crawls/[id]
   * page was a second copy of this one, and two copies of a map is how the
   * two drift apart.
   */
  const crawlParam = searchParams.get('crawl')

  const [exhibitions, setExhibitions] = useState<MapExhibition[]>([])
  const [loading, setLoading] = useState(true)
  const [venueFilter, setVenueFilter] = useState<VenueFilter>('all')
  const [subFilter, setSubFilter] = useState<SubFilter>(null)

  const [selectedDate, setSelectedDate] = useState(todayStr)
  const [windowStart, setWindowStart] = useState(nowTimeStr)
  const [windowEnd, setWindowEnd] = useState(defaultEndTime)

  /**
   * THE ITINERARY IS ALSO THE CRAWL DRAFT. One list, not two.
   *
   * This page already had everything a crawl needs to be built: adding a show
   * from its pin, dragging stops into order, ↑/↓, removing. A crawl is that
   * list, in that order, saved. Keeping a second parallel list of "crawl
   * stops" beside this one would put two orderings on one screen and force
   * somebody to keep them in step by hand.
   *
   * What the itinerary carries that a crawl does not — minutes at each venue,
   * the date and time window, walk-or-drive per leg, the arrival times and
   * risk flags — stays exactly as it was and is NOT saved. Those answer "can I
   * fit this into Saturday afternoon"; a crawl answers "this is the walk". The
   * crawl keeps the ORDER, which is the part both questions share.
   */
  const [itinerary, setItinerary] = useState<ItineraryStop[]>([])
  const [legs, setLegs] = useState<DirectionLeg[]>([])
  const [legsLoading, setLegsLoading] = useState(false)
  const [legModes, setLegModes] = useState<('walking' | 'driving')[]>([])

  // ── Crawl state ────────────────────────────────────────────────────────────
  //
  // `crawlId` null means the itinerary has never been saved as a crawl. Saving
  // it creates one; opening ?crawl=<id> adopts an existing one.
  const [crawlId, setCrawlId] = useState<string | null>(null)
  const [crawlTitle, setCrawlTitle] = useState('')
  const [savedCrawlTitle, setSavedCrawlTitle] = useState('')
  const [crawlStatus, setCrawlStatus] = useState<CrawlStatus>('draft')
  /** The stop ids as the database last accepted them, for the unsaved marker. */
  const [savedStopIds, setSavedStopIds] = useState<string[]>([])
  const [crawlBusy, setCrawlBusy] = useState(false)
  const [crawlError, setCrawlError] = useState<string | null>(null)
  const [crawlNotice, setCrawlNotice] = useState<string | null>(null)
  const [crawlLoading, setCrawlLoading] = useState(Boolean(crawlParam))
  /** Null until the session is known, then the signed-in id or null. */
  const [userId, setUserId] = useState<string | null>(null)
  const [sessionKnown, setSessionKnown] = useState(false)

  /** The traced walking route, and whether the style is ready to draw it. */
  const [routeData, setRouteData] = useState<CrawlRoute | null>(null)
  const [routeLoading, setRouteLoading] = useState(false)
  const [mapReady, setMapReady] = useState(false)

  const [isMobile, setIsMobile] = useState(false)
  const [mobileSelected, setMobileSelected] = useState<MapExhibition[] | null>(null)

  // Drag-and-drop state
  const dragIdxRef = useRef<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<Array<{ marker: mapboxgl.Marker; id: string }>>([])
  /**
   * The numbered stop pins, kept in their OWN list and their own effect.
   *
   * They could have been folded into the pass above by giving that effect the
   * itinerary as a dependency. They are not, deliberately: that effect rebuilds
   * every pin on the map and tears down any open popup, and it would then do so
   * on every add, drag and removal. Separate layers mean arranging a route
   * costs one small redraw of the stops, not eighty pins and the popup somebody
   * is reading.
   *
   * Added after the base pins on every pass, so a stop's numbered badge sits on
   * top of the ordinary dot at the same point rather than behind it.
   */
  const crawlMarkersRef = useRef<mapboxgl.Marker[]>([])
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

  // ── Who is looking ─────────────────────────────────────────────────────────
  //
  // /map is a PUBLIC page, so this can legitimately be nobody. The crawl bar
  // uses it to decide between "Save as crawl" and "Sign in to save", and
  // nothing else on the page depends on it — browsing, the itinerary and the
  // route all work signed out, exactly as before.
  //
  // Read in the browser, like AccountNav, because reading cookies on the server
  // would make this page render per visitor instead of being cached.
  useEffect(() => {
    const supabase = getSupabaseBrowser()
    let cancelled = false

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // A token refresh is not a change of person.
      if (event === 'TOKEN_REFRESHED') return
      if (cancelled) return
      setUserId(session?.user.id ?? null)
      setSessionKnown(true)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  // ── Opening a saved crawl ──────────────────────────────────────────────────
  //
  // Waits for the exhibition feed, because a stop that is still on view should
  // become the SAME MapExhibition object the pins and popups use — venue hours
  // and all — so the itinerary's timing, the risk flags and the popup's "add"
  // button all behave as if the person had clicked the pin themselves.
  //
  // A stop whose show has CLOSED is not in that feed, and is synthesised from
  // what the server sent instead. Dropping it would renumber every stop after
  // it and quietly turn a saved route into a different one. It carries no
  // venue_hours, so the itinerary simply has nothing to say about whether it is
  // open — which is honest, since it is not.
  useEffect(() => {
    if (!crawlParam || !exhibitions.length) return
    let cancelled = false

    // No setCrawlLoading(true) here. The state is initialised to
    // Boolean(crawlParam), so it is already true on the first render of a page
    // opened with ?crawl= — before this effect, before the feed arrives, and
    // before the fetch starts. Setting it again synchronously inside the effect
    // would say nothing new and would cost a second render pass.
    fetch(`/api/crawls/${crawlParam}/stops`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('not_found'))))
      .then((stops: CrawlStopDetail[]) => {
        if (cancelled) return
        const byId = new Map(exhibitions.map(e => [e.id, e]))
        setItinerary(
          stops.map(stop => {
            const live = byId.get(stop.exhibition_id)
            const exhibition: MapExhibition = live ?? {
              id: stop.exhibition_id,
              show_title: stop.show_title,
              artists: [],
              institution_name: stop.venue_name,
              institution_id: null,
              venue_type: 'gallery',
              image_url: stop.image_url,
              start_date: null,
              end_date: stop.end_date,
              venue_id: stop.exhibition_id,
              venue_name: stop.venue_name,
              venue_lat: stop.lat,
              venue_lng: stop.lng,
              venue_hours: null,
              venue_address: null,
            }
            return { exhibitionId: stop.exhibition_id, exhibition, minutesAtVenue: 15 }
          })
        )
        setSavedStopIds(stops.map(s => s.exhibition_id))
        setCrawlId(crawlParam)
        setCrawlLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        // "No such crawl" and "not yours" arrive identically from the server,
        // on purpose, and are reported identically here.
        setCrawlError('That crawl could not be opened.')
        setCrawlLoading(false)
      })

    return () => { cancelled = true }
  }, [crawlParam, exhibitions])

  // The crawl's own title, fetched separately because the stops endpoint
  // answers about stops. Read straight from PostgREST under RLS: a crawl row is
  // three plain columns and its owner has a SELECT policy on them, so there is
  // nothing here an API route would add but a hop.
  useEffect(() => {
    if (!crawlParam || !userId) return
    let cancelled = false

    getSupabaseBrowser()
      .from('crawls')
      .select('title, status')
      .eq('id', crawlParam)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return
        const row = data as { title: string; status: CrawlStatus }
        setCrawlTitle(row.title)
        setSavedCrawlTitle(row.title)
        setCrawlStatus(row.status)
      })

    return () => { cancelled = true }
  }, [crawlParam, userId])

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

    map.on('load', () => {
      map.addSource('crawl-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      // FOUR LAYERS OVER ONE SOURCE: a casing and a line for each of the two
      // kinds of leg, split on `drawn` — whether Mapbox actually returned a
      // route for this one. A real routed leg and a guessed straight line must
      // not look alike; the whole point of the per-leg fallback is that it is
      // visible.
      //
      // The split is NOT on the travel mode. A walked leg and a driven leg are
      // both the route somebody chose, and drawing them differently would
      // invent a distinction the person did not ask the map to make — the
      // itinerary's own toggle is where the mode is stated. What the map has to
      // show is real-versus-guessed.
      //
      // ROUTE_BLUE is the pin blue from lib/mapMarkers.ts, reused rather than
      // re-picked so the line and the stops read as one object.
      // ── The casings go down FIRST ───────────────────────────────────────
      //
      // Mapbox draws layers in the order they are added, so a casing added
      // after its line would cover it. These two are the light edge that lifts
      // the blue off a dark navy map — the same trick the pins use, which is
      // why it keeps the line and the stops looking like one object instead of
      // two separate decisions about visibility.
      //
      // Each is 2.5px wider than the line it sits under, so 1.25px of cream
      // shows on either side: enough to separate the blue from whatever is
      // beneath it, not so much that the route reads as a cream line with a
      // blue core.
      map.addLayer({
        id: 'crawl-route-casing-drawn',
        type: 'line',
        source: 'crawl-route',
        filter: ['==', ['get', 'drawn'], 'route'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ROUTE_CASING, 'line-width': 5, 'line-opacity': 0.9 },
      })

      // THE FALLBACK'S CASING HAS TO BE DASHED TOO. A solid casing under a
      // dashed line fills its gaps with cream and the leg reads as solid —
      // which would erase the one distinction these two layers exist to make.
      //
      // AND ITS DASH ARRAY IS NOT THE LINE'S. Mapbox measures dashes in
      // multiples of the line's own width, so repeating [2, 2.5] at 4.25px
      // would draw dashes nearly two and a half times longer than the 1.75px
      // line's and the casing would slide out from under it. The values below
      // are the line's, scaled by the width ratio, so both layers dash at the
      // same physical length: 2 × 1.75 = 3.5px of dash, 2.5 × 1.75 = 4.375px
      // of gap, which at 4.25px wide is [0.824, 1.029].
      map.addLayer({
        id: 'crawl-route-casing-straight',
        type: 'line',
        source: 'crawl-route',
        filter: ['==', ['get', 'drawn'], 'straight'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ROUTE_CASING,
          'line-width': 4.25,
          'line-opacity': 0.75,
          'line-dasharray': [0.824, 1.029],
        },
      })

      map.addLayer({
        id: 'crawl-route-drawn',
        type: 'line',
        source: 'crawl-route',
        filter: ['==', ['get', 'drawn'], 'route'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ROUTE_BLUE, 'line-width': 2.5, 'line-opacity': 1 },
      })

      // The same blue, dashed and thinner still. Same colour because it is the
      // same route; dashed because this leg is a guess.
      map.addLayer({
        id: 'crawl-route-straight',
        type: 'line',
        source: 'crawl-route',
        filter: ['==', ['get', 'drawn'], 'straight'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ROUTE_BLUE,
          'line-width': 1.75,
          'line-opacity': 0.8,
          'line-dasharray': [2, 2.5],
        },
      })

      // The draw effect waits on this. A crawl opened from a profile has its
      // stops before the style finishes loading, so the first draw has to be
      // triggered from here rather than from the data, which was already there.
      setMapReady(true)
    })

    mapRef.current = map
    return () => {
      markersRef.current.forEach(({ marker }) => marker.remove())
      markersRef.current = []
      crawlMarkersRef.current.forEach(marker => marker.remove())
      crawlMarkersRef.current = []
      setMapReady(false)
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
      : exhibitions.filter(ex => tabMatches(venueFilter as VenueTab, ex.venue_type))
    if (subFilter === 'closing-soon') visible = visible.filter(isClosingSoon)

    // One pin per venue per place: a venue's shows share a pin unless one has
    // resolved to a different address (address_override or show_location).
    const pins = groupByPlace(
      visible.filter(ex => ex.venue_lat && ex.venue_lng),
      ex => ({ venueId: ex.venue_id, lat: ex.venue_lat!, lng: ex.venue_lng! })
    )

    pins.forEach(shows => {
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

  // ── The traced route ─────────────────────────────────────────────────────────

  /**
   * The stops that can actually be placed, with their position in the list.
   *
   * A stop with no coordinates is skipped rather than routed through (0, 0) in
   * the Atlantic, and the legs either side of it join up. It keeps its number
   * in the panel — it is still a stop, it just cannot be drawn.
   */
  const placeable = useMemo(
    () =>
      itinerary
        .map((stop, index) => {
          const { venue_lat: lat, venue_lng: lng } = stop.exhibition
          return lat != null && lng != null ? { index, lat, lng } : null
        })
        .filter((p): p is { index: number; lat: number; lng: number } => p !== null),
    [itinerary]
  )

  /**
   * THE DRAWN LINE FOLLOWS EACH LEG'S OWN MODE.
   *
   * The itinerary's per-leg walk/drive toggle decides how that leg is routed,
   * so a crawl walked as far as 24th Street and driven from there gets a
   * pavement line and then a road line. They are genuinely different routes
   * over the same two points — a driving leg obeys one-way streets and misses
   * the pedestrian cut-through the walking leg takes — and drawing one profile
   * for the whole route said "walk this" over a leg the person had already told
   * us they were driving.
   *
   * WHICH MODE APPLIES WHEN A STOP CANNOT BE PLACED. `placeable` skips stops
   * with no coordinates, so a drawn leg can span more than one itinerary leg.
   * It takes the mode of the leg LEAVING its origin — legModes[from_index] —
   * because that is the choice the person made about setting off from the stop
   * the line actually starts at. An unplaceable stop is rare: a show that
   * closed and never had an address resolved.
   *
   * legModes[i] is the leg from stop i to stop i+1, and defaults to walking,
   * exactly as the itinerary's own reads of it do.
   */
  const routeLegs = useMemo(
    () =>
      placeable.slice(0, -1).map((from, i) => {
        const to = placeable[i + 1]
        return {
          from_index: from.index,
          to_index: to.index,
          from: [from.lng, from.lat] as [number, number],
          to: [to.lng, to.lat] as [number, number],
          mode: legModes[from.index] ?? 'walking',
        }
      }),
    [placeable, legModes]
  )

  /**
   * What makes two route requests the same request.
   *
   * The coordinates in order AND the mode of each leg, because flipping one
   * leg to driving has to redraw that leg even though every stop stayed
   * exactly where it was. Keyed on a string so a re-render that rebuilds an
   * identical array does not refetch.
   */
  const routeKey = useMemo(
    () =>
      routeLegs
        .map(l => `${l.mode}:${l.from[0].toFixed(5)},${l.from[1].toFixed(5)}>${l.to[0].toFixed(5)},${l.to[1].toFixed(5)}`)
        .join('|'),
    [routeLegs]
  )

  useEffect(() => {
    // Nothing to ask for. `crawlRoute` reads as empty on its own, below.
    if (routeLegs.length === 0) return

    // Debounced, and aborted: dragging a stop through three slots should ask
    // for one route, not three, and an earlier request landing late would
    // otherwise draw an order nobody is looking at.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setRouteLoading(true)
      fetch('/api/crawl-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legs: routeLegs }),
        signal: controller.signal,
      })
        .then(r => (r.ok ? r.json() : { segments: [], fallback_count: 0 }))
        .then((data: CrawlRoute) => { setRouteData(data); setRouteLoading(false) })
        .catch(e => {
          if (e?.name === 'AbortError') return
          setRouteData({ segments: [], fallback_count: 0 })
          setRouteLoading(false)
        })
    }, 350)

    return () => { clearTimeout(timer); controller.abort() }
    // routeKey rather than `routeLegs`: a new array describing the same legs in
    // the same modes is the same route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  /**
   * The route as it should be drawn right now.
   *
   * Derived rather than written into state when it empties, so removing the
   * second-to-last stop erases the line at once instead of leaving the previous
   * answer on the map until a fetch that will never happen returns.
   */
  const crawlRoute: CrawlRoute | null = useMemo(
    () => (routeLegs.length === 0 ? { segments: [], fallback_count: 0 } : routeData),
    [routeLegs.length, routeData]
  )

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const source = map.getSource('crawl-route') as mapboxgl.GeoJSONSource | undefined
    if (!source) return

    source.setData({
      type: 'FeatureCollection',
      features: (crawlRoute?.segments ?? []).map(seg => ({
        type: 'Feature' as const,
        properties: { drawn: seg.drawn },
        geometry: { type: 'LineString' as const, coordinates: seg.geometry },
      })),
    })
  }, [crawlRoute, mapReady])

  // The numbered, labelled stop pins. Its own pass — see crawlMarkersRef.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    crawlMarkersRef.current.forEach(marker => marker.remove())
    crawlMarkersRef.current = []

    itinerary.forEach((stop, i) => {
      const { venue_lat: lat, venue_lng: lng, institution_name, venue_name } = stop.exhibition
      if (lat == null || lng == null) return
      const el = createCrawlStopEl(i + 1, institution_name || venue_name)
      const marker = new mapboxgl.Marker({ element: el, anchor: 'left' })
        .setLngLat([lng, lat])
        .addTo(map)
      crawlMarkersRef.current.push(marker)
    })
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

  /**
   * What to say about legs that could not be routed, if anything.
   *
   * Read off the segments rather than from fallback_count alone, because on a
   * mixed route the COUNT is not enough to word it: two dashed legs might be
   * one walking failure and one driving failure, and "2 legs — no walking
   * directions available" would be wrong about one of them.
   *
   * Each failed leg reports the mode it asked for, so the modes are counted
   * and named. Null when everything routed, which is the ordinary case and the
   * one that should say nothing at all.
   */
  const fallbackNotice = useMemo(() => {
    const failed = (crawlRoute?.segments ?? []).filter(s => s.drawn === 'straight')
    if (failed.length === 0) return null

    const counts = { walking: 0, driving: 0 }
    failed.forEach(s => { counts[s.travel_mode] += 1 })

    const parts: string[] = []
    if (counts.walking) parts.push(`${counts.walking} with no walking directions`)
    if (counts.driving) parts.push(`${counts.driving} with no driving directions`)

    const legWord = failed.length === 1 ? 'leg' : 'legs'
    return `${failed.length} ${legWord} shown as a straight line — ${parts.join(', ')}.`
  }, [crawlRoute])

  // ── Saving the itinerary as a crawl ──────────────────────────────────────────

  const stopIds = useMemo(() => itinerary.map(s => s.exhibitionId), [itinerary])

  const crawlDirty =
    stopIds.length !== savedStopIds.length ||
    stopIds.some((id, i) => id !== savedStopIds[i])

  /**
   * Save the itinerary's ORDER as a crawl, creating one on the first save.
   *
   * The stops go in as a whole list, always, because that is the only way in:
   * migration_v66 grants no row-level writes on crawl_stops, and
   * set_crawl_stops() empties the crawl and lays the new order down in one
   * transaction. That is what makes a reorder unable to half-happen and what
   * keeps positions 1..n gap-free — see lib/crawl-writes.ts. None of that
   * changed when this moved onto the map; only where the button lives did.
   */
  async function saveAsCrawl() {
    if (!userId || itinerary.length === 0) return

    setCrawlBusy(true)
    setCrawlError(null)
    setCrawlNotice(null)

    const supabase = getSupabaseBrowser()
    let id = crawlId

    if (!id) {
      const title = crawlTitle.trim() || 'Untitled crawl'
      const { id: made, error } = await createCrawl(supabase, userId, title)
      if (error || !made) {
        setCrawlBusy(false)
        setCrawlError(error?.message ?? 'Could not save that crawl.')
        return
      }
      id = made
      setCrawlId(made)
      setCrawlTitle(title)
      setSavedCrawlTitle(title)
    }

    const { error } = await saveCrawlStops(supabase, id, stopIds)
    setCrawlBusy(false)

    if (error) {
      // The draft is deliberately kept. The person may be able to fix it by
      // removing the offending stop, and throwing their arrangement away would
      // be a second loss on top of the failure.
      setCrawlError(error.message)
      return
    }

    setSavedStopIds(stopIds)
    setCrawlNotice('Saved.')
  }

  async function renameThisCrawl() {
    const next = crawlTitle.trim()
    if (!crawlId || !next || next === savedCrawlTitle) {
      if (crawlId) setCrawlTitle(savedCrawlTitle)
      return
    }
    setCrawlBusy(true)
    setCrawlError(null)
    const { error } = await renameCrawl(getSupabaseBrowser(), crawlId, next)
    setCrawlBusy(false)
    if (error) {
      setCrawlError(error.message)
      setCrawlTitle(savedCrawlTitle)
      return
    }
    setSavedCrawlTitle(next)
  }

  /** Draft ↔ planned. Neither changes who may see it — both are owner-only. */
  async function toggleCrawlStatus() {
    if (!crawlId) return
    const next: CrawlStatus = crawlStatus === 'draft' ? 'planned' : 'draft'
    setCrawlBusy(true)
    setCrawlError(null)
    const { error } = await writeCrawlStatus(getSupabaseBrowser(), crawlId, next)
    setCrawlBusy(false)
    if (error) { setCrawlError(error.message); return }
    setCrawlStatus(next)
  }

  async function deleteThisCrawl() {
    if (!crawlId) return
    // Somebody's arrangement of an afternoon, and the delete cascades to its
    // stops. There is no undo behind this, so it asks.
    if (!window.confirm('Delete this crawl? This cannot be undone.')) return
    setCrawlBusy(true)
    const { error } = await deleteCrawl(getSupabaseBrowser(), crawlId)
    setCrawlBusy(false)
    if (error) { setCrawlError(error.message); return }
    // The itinerary stays on screen. The crawl is gone, but the afternoon
    // somebody just planned is not the thing they asked to delete, and wiping
    // the map as a side effect would take it from them.
    setCrawlId(null)
    setSavedStopIds([])
    setCrawlTitle('')
    setSavedCrawlTitle('')
    setCrawlStatus('draft')
    setCrawlNotice('Crawl deleted. These stops are still here.')
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
          <AccountNav />
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
              <p className="mp-empty-hint">
                {crawlLoading
                  ? 'Loading your crawl…'
                  : 'add an itinerary stop by clicking onto a pin and adding it to the itinerary'}
              </p>
              {/* Two stops is where a crawl starts being a walk rather than a
                  destination, which is also when the line appears. */}
              <p className="mp-empty-hint">
                Add two or more and the walk between them is drawn on the map —
                save it as a crawl to come back to it.
              </p>
              {crawlError && <p className="mp-crawl-error">{crawlError}</p>}
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

              {/* ── Save this as a crawl ────────────────────────────────────
                  Below the itinerary because it is about the whole list: the
                  stops above ARE the crawl, in the order they are shown. */}
              <div className="mp-crawl">
                <div className="mp-crawl-head">
                  <h2 className="mp-crawl-title">
                    {crawlId ? 'Crawl' : 'Save as a crawl'}
                  </h2>
                  <span className="mp-crawl-count">
                    {itinerary.length} of {CRAWL_MAX_STOPS}
                  </span>
                </div>

                {/* The walking line and the labels are already on the map for
                    everyone; only KEEPING it needs an account. */}
                {!sessionKnown ? (
                  <p className="mp-crawl-hint">&nbsp;</p>
                ) : !userId ? (
                  <p className="mp-crawl-hint">
                    <Link href="/login?next=%2Fmap">Sign in</Link> to save this
                    walk as a crawl you can come back to.
                  </p>
                ) : (
                  <>
                    <input
                      className="mp-crawl-name"
                      value={crawlTitle}
                      maxLength={120}
                      placeholder="Name this crawl"
                      aria-label="Crawl name"
                      disabled={crawlBusy}
                      onChange={e => setCrawlTitle(e.target.value)}
                      onBlur={() => { if (crawlId) renameThisCrawl() }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape' && crawlId) setCrawlTitle(savedCrawlTitle)
                      }}
                    />

                    <div className="mp-crawl-actions">
                      <button
                        type="button"
                        className="mp-crawl-save"
                        onClick={saveAsCrawl}
                        disabled={crawlBusy || itinerary.length === 0 || (!!crawlId && !crawlDirty)}
                      >
                        {crawlBusy
                          ? 'Saving…'
                          : !crawlId
                            ? 'Save as crawl'
                            : crawlDirty ? 'Save changes' : 'Saved'}
                      </button>

                      {crawlId && (
                        <>
                          <button
                            type="button"
                            className="mp-crawl-status"
                            onClick={toggleCrawlStatus}
                            disabled={crawlBusy}
                          >
                            {crawlStatus === 'draft' ? 'Draft' : 'Planned'}
                          </button>
                          <button
                            type="button"
                            className="mp-crawl-delete"
                            onClick={deleteThisCrawl}
                            disabled={crawlBusy}
                          >
                            Delete
                          </button>
                        </>
                      )}

                      {crawlId && crawlDirty && !crawlBusy && (
                        <span className="mp-crawl-note">Unsaved changes</span>
                      )}
                      {!crawlDirty && crawlNotice && (
                        <span className="mp-crawl-note">{crawlNotice}</span>
                      )}
                    </div>

                    <p className="mp-crawl-hint">
                      Only you can see your crawls.
                      {routeLoading
                        ? ' Working out the route…'
                        // Said plainly rather than hidden, and naming the mode
                        // that failed — see fallbackNotice.
                        : fallbackNotice ? ` ${fallbackNotice}` : ''}
                    </p>
                  </>
                )}

                {crawlError && <p className="mp-crawl-error">{crawlError}</p>}
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

