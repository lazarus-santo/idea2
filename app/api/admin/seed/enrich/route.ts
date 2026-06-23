import { NextRequest, NextResponse } from 'next/server'

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

type HoursMap = Record<string, [string, string] | null>

const DEFAULT_HOURS: HoursMap = {
  monday: null,
  tuesday: ['10:00', '18:00'],
  wednesday: ['10:00', '18:00'],
  thursday: ['10:00', '18:00'],
  friday: ['10:00', '18:00'],
  saturday: ['10:00', '18:00'],
  sunday: null,
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function trimToZip(placeName: string): string {
  const match = placeName.match(/^(.*\b\d{5}(?:-\d{4})?)/)
  return match ? match[1] : placeName
}

async function geocodeMapbox(address: string): Promise<{ lat: number; lng: number; placeName: string } | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (!token) return null
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${token}&limit=1&country=US`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const data = await res.json()
    const feature = data.features?.[0]
    if (!feature) return null
    const [lng, lat] = feature.center as [number, number]
    return { lat, lng, placeName: trimToZip(feature.place_name as string) }
  } catch {
    return null
  }
}

async function fetchGoogleHours(name: string, address: string): Promise<HoursMap | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY
  if (!key) return null
  try {
    const textQuery = [name, address].filter(Boolean).join(' ')

    // Text Search (New) — request only place ID to minimize billing
    const searchRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id',
      },
      body: JSON.stringify({ textQuery }),
      signal: AbortSignal.timeout(8000),
    })
    if (!searchRes.ok) return null
    const searchData = await searchRes.json()
    const placeId = searchData.places?.[0]?.id as string | undefined
    if (!placeId) return null

    // Place Details (New) — request only regularOpeningHours to minimize billing
    const detailRes = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'regularOpeningHours',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!detailRes.ok) return null
    const detail = await detailRes.json()

    const periods = detail.regularOpeningHours?.periods as Array<{
      open: { day: number; hour: number; minute: number }
      close?: { day: number; hour: number; minute: number }
    }> | undefined
    if (!periods?.length) return null

    const hours: HoursMap = {
      monday: null, tuesday: null, wednesday: null, thursday: null,
      friday: null, saturday: null, sunday: null,
    }
    for (const period of periods) {
      const dayName = DAY_NAMES[period.open.day]
      if (!dayName) continue
      const openStr = `${pad(period.open.hour)}:${pad(period.open.minute)}`
      const closeStr = period.close
        ? `${pad(period.close.hour)}:${pad(period.close.minute)}`
        : '23:59'
      hours[dayName] = [openStr, closeStr]
    }
    return hours
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const name: string = body.name ?? ''
  const address: string = body.address ?? ''

  if (!address.trim()) {
    return NextResponse.json({ error: 'address is required' }, { status: 400 })
  }

  const [geoResult, googleHours] = await Promise.all([
    geocodeMapbox(address),
    fetchGoogleHours(name, address),
  ])

  return NextResponse.json({
    lat: geoResult?.lat ?? null,
    lng: geoResult?.lng ?? null,
    address: geoResult?.placeName ?? null,
    addressFallback: geoResult === null,
    hours: googleHours ?? DEFAULT_HOURS,
    hoursFallback: googleHours === null,
  })
}
