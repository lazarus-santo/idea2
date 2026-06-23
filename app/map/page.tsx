import { Suspense } from 'react'
import MapClient from './MapClient'

export const metadata = { title: 'Map — Idea 2' }

export default function MapPage() {
  return (
    <Suspense>
      <MapClient />
    </Suspense>
  )
}
