import { NextResponse } from 'next/server'
import type { DirectionLeg } from '@/lib/types'

// Module-level cache: survives across requests in the same process.
// Key: "lng1,lat1_lng2,lat2"
const cache = new Map<string, DirectionLeg>()

async function fetchDurationMinutes(
  origin: [number, number],
  destination: [number, number],
  profile: 'walking' | 'driving'
): Promise<number | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (!token) return null

  const coords = `${origin[0]},${origin[1]};${destination[0]},${destination[1]}`
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}?access_token=${token}&overview=false`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const json = await res.json()
    const seconds = json.routes?.[0]?.duration
    if (typeof seconds !== 'number') return null
    return Math.round(seconds / 60)
  } catch {
    return null
  }
}

export async function POST(req: Request) {
  const { origin, destination } = await req.json() as {
    origin: [number, number]
    destination: [number, number]
  }

  const key = `${origin[0].toFixed(5)},${origin[1].toFixed(5)}_${destination[0].toFixed(5)},${destination[1].toFixed(5)}`

  if (cache.has(key)) {
    return NextResponse.json(cache.get(key))
  }

  const [walkingMinutes, drivingMinutes] = await Promise.all([
    fetchDurationMinutes(origin, destination, 'walking'),
    fetchDurationMinutes(origin, destination, 'driving'),
  ])

  const result: DirectionLeg = { walkingMinutes, drivingMinutes }
  cache.set(key, result)

  return NextResponse.json(result)
}
