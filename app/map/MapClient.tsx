'use client'

import dynamic from 'next/dynamic'

const StandaloneMap = dynamic(() => import('@/components/StandaloneMap'), { ssr: false })

export default function MapClient() {
  return <StandaloneMap />
}
