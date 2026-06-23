'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

type Category = 'exhibition' | 'institution' | 'reading' | 'artist'
type TabFilter = 'all' | Category

interface FlatItem {
  id: string
  title: string
  category: Category
  image_url: string | null
  url: string | null
  is_external: boolean
  subtitle: string | null
  fromArtist?: boolean
}

interface SubResult {
  id: string
  title: string
  image_url: string | null
  url: string | null
  is_external: boolean
  subtitle: string | null
}

interface EnrichedResult {
  id: string
  name: string
  category: 'artist' | 'institution'
  url: string | null
  exhibitions: SubResult[]
  readings: SubResult[]
}

interface SearchResponse {
  exhibitions: FlatItem[]
  institutions: EnrichedResult[]
  readings: FlatItem[]
  artists: EnrichedResult[]
}

const CATEGORY_LABEL: Record<Category, string> = {
  exhibition: 'Exhibition',
  institution: 'Institution',
  reading: 'Reading',
  artist: 'Artist',
}

function flattenResults(data: SearchResponse): FlatItem[] {
  const seenEx = new Set<string>()
  const seenRd = new Set<string>()
  const seenInst = new Set<string>()
  const items: FlatItem[] = []

  for (const artist of data.artists) {
    for (const ex of artist.exhibitions) {
      if (!seenEx.has(ex.id)) {
        seenEx.add(ex.id)
        items.push({ id: ex.id, title: ex.title, category: 'exhibition', image_url: ex.image_url, url: ex.url, is_external: false, subtitle: ex.subtitle, fromArtist: true })
      }
    }
    for (const rd of artist.readings) {
      if (!seenRd.has(rd.id)) {
        seenRd.add(rd.id)
        items.push({ id: rd.id, title: rd.title, category: 'reading', image_url: rd.image_url, url: rd.url, is_external: true, subtitle: rd.subtitle, fromArtist: true })
      }
    }
  }

  for (const inst of data.institutions) {
    if (!seenInst.has(inst.id)) {
      seenInst.add(inst.id)
      items.push({ id: inst.id, title: inst.name, category: 'institution', image_url: null, url: inst.url, is_external: false, subtitle: null })
    }
    for (const ex of inst.exhibitions) {
      if (!seenEx.has(ex.id)) {
        seenEx.add(ex.id)
        items.push({ id: ex.id, title: ex.title, category: 'exhibition', image_url: ex.image_url, url: ex.url, is_external: false, subtitle: ex.subtitle })
      }
    }
    for (const rd of inst.readings) {
      if (!seenRd.has(rd.id)) {
        seenRd.add(rd.id)
        items.push({ id: rd.id, title: rd.title, category: 'reading', image_url: rd.image_url, url: rd.url, is_external: true, subtitle: rd.subtitle })
      }
    }
  }

  for (const ex of data.exhibitions) {
    if (!seenEx.has(ex.id)) {
      seenEx.add(ex.id)
      items.push(ex)
    }
  }

  for (const rd of data.readings) {
    if (!seenRd.has(rd.id)) {
      seenRd.add(rd.id)
      items.push(rd)
    }
  }

  return items
}

function Thumbnail({ url }: { url: string | null }) {
  return (
    <div className="sr-thumb">
      {url ? <img src={url} alt="" className="sr-thumb-img" /> : <div className="sr-thumb-empty" />}
    </div>
  )
}

function ResultRow({ result, onClick }: { result: FlatItem; onClick?: () => void }) {
  const inner = (
    <>
      <Thumbnail url={result.image_url} />
      <div className="sr-row-text">
        <span className="sr-row-title">
          {result.title}
          {result.is_external && <span className="sr-external-icon"> ↗</span>}
        </span>
        <span className="sr-row-category">{CATEGORY_LABEL[result.category]}</span>
      </div>
    </>
  )
  if (result.is_external && result.url) {
    return (
      <a href={result.url} target="_blank" rel="noopener noreferrer" className="sr-row" onClick={onClick}>
        {inner}
      </a>
    )
  }
  if (result.url) {
    return <Link href={result.url} className="sr-row" onClick={onClick}>{inner}</Link>
  }
  return <div className="sr-row sr-row--no-link">{inner}</div>
}

export default function SearchPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlQuery = searchParams.get('q') ?? ''
  const urlCategory = searchParams.get('category') ?? ''

  const [inputValue, setInputValue] = useState(urlQuery)
  const [dropdownItems, setDropdownItems] = useState<FlatItem[]>([])
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [fullResults, setFullResults] = useState<SearchResponse | null>(null)
  const [activeTab, setActiveTab] = useState<TabFilter>(urlCategory === 'artists' ? 'artist' : 'all')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setInputValue(urlQuery)
    setIsDropdownOpen(false)
    setActiveTab(urlCategory === 'artists' ? 'artist' : 'all')
  }, [urlQuery, urlCategory])

  useEffect(() => {
    if (!urlQuery) { setFullResults(null); return }
    fetch(`/api/search?q=${encodeURIComponent(urlQuery)}&mode=full`)
      .then(r => r.json())
      .then((data: SearchResponse) => setFullResults(data))
      .catch(() => {})
  }, [urlQuery])

  const handleInputChange = useCallback((val: string) => {
    setInputValue(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!val.trim() || val.length < 2) {
      setDropdownItems([])
      setIsDropdownOpen(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(val)}&mode=dropdown`)
        const data: SearchResponse = await res.json()
        const all = flattenResults(data).slice(0, 6)
        setDropdownItems(all)
        setIsDropdownOpen(all.length > 0)
      } catch {
        // ignore
      }
    }, 300)
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmed = inputValue.trim()
    if (!trimmed) return
    setIsDropdownOpen(false)
    router.push(`/search?q=${encodeURIComponent(trimmed)}`)
  }, [inputValue, router])

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const isFullResults = !!urlQuery

  const allFlat = fullResults ? flattenResults(fullResults) : []
  const visibleResults =
    activeTab === 'all' ? allFlat :
    activeTab === 'artist' ? allFlat.filter(r => r.fromArtist) :
    allFlat.filter(r => r.category === activeTab)

  return (
    <div className="sr-page">
      {/* Nav */}
      <nav className="ei-nav">
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

      {/* Search bar + dropdown container */}
      <div className="sr-main">
        <div className="sr-search-wrap" ref={containerRef}>
          <input
            type="text"
            className={`sr-input${inputValue ? ' sr-input--active' : ''}`}
            placeholder="Search by exhibition, institution, reading, artist"
            value={inputValue}
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            onFocus={() => {
              if (inputValue.length >= 2 && dropdownItems.length > 0) {
                setIsDropdownOpen(true)
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />

          {/* Dropdown — shows while typing, including when on results page if input differs from current query */}
          {isDropdownOpen && dropdownItems.length > 0 && (!isFullResults || inputValue.trim() !== urlQuery) && (
            <div className="sr-dropdown">
              {dropdownItems.map(r => (
                <ResultRow
                  key={`${r.category}-${r.id}`}
                  result={r}
                  onClick={() => setIsDropdownOpen(false)}
                />
              ))}
              <button className="sr-see-all" onClick={handleSubmit}>
                See full results
              </button>
            </div>
          )}
        </div>

        {/* Full results */}
        {isFullResults && (
          <div className="sr-results">
            <p className="sr-results-label">
              Results for <strong className="sr-results-query">{urlQuery}</strong>
            </p>

            {/* Category tabs */}
            <div className="sr-tabs">
              {(['all', 'exhibition', 'institution', 'reading', 'artist'] as TabFilter[]).map(tab => (
                <button
                  key={tab}
                  className={`sr-tab${activeTab === tab ? ' sr-tab--active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === 'all' ? 'All' : `${CATEGORY_LABEL[tab as Category]}s`}
                </button>
              ))}
            </div>

            {/* Results list */}
            {fullResults === null ? (
              <div className="sr-loading" />
            ) : visibleResults.length === 0 ? (
              <p className="sr-empty">
                {activeTab === 'artist'
                  ? 'Nothing yet — check back as we add more venues.'
                  : 'No results found.'}
              </p>
            ) : (
              <div className="sr-list">
                {visibleResults.map(r => (
                  <ResultRow key={`${r.category}-${r.id}`} result={r} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
