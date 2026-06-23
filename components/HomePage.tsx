'use client'
import { useEffect } from 'react'
import Link from 'next/link'

export default function HomePage() {
  useEffect(() => {
    const el = document.documentElement
    el.style.background = 'linear-gradient(135deg, #3432A8 0%, #0D0B3E 100%)'
    document.body.style.overflow = 'hidden'
    return () => {
      el.style.background = ''
      document.body.style.overflow = ''
    }
  }, [])

  return (
    <div className="home-page">
      <div className="home-center">
        <h1 className="home-logo-text">Idea 2</h1>
        <p className="home-tagline">Your art world friend helping you navigate what&rsquo;s on and what to read</p>
        <nav className="home-links">
          <Link href="/exhibitions">Exhibitions</Link>
          <Link href="/readings">Readings</Link>
          <Link href="/editors-picks">Editor&rsquo;s Picks</Link>
        </nav>
      </div>
    </div>
  )
}
