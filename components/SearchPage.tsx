'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

type Category = 'exhibition' | 'institution' | 'reading' | 'artist' | 'user'
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
  /** Users only: shown beside the label, since display names aren't unique. */
  handle?: string
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

interface UserResult {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  url: string
}

interface SearchResponse {
  exhibitions: FlatItem[]
  institutions: EnrichedResult[]
  readings: FlatItem[]
  artists: EnrichedResult[]
  users?: UserResult[]
}

/** Most users shown in the dropdown, and in the All tab before "See all users". */
const USERS_SHOWN = 3

const CATEGORY_LABEL: Record<Category, string> = {
  exhibition: 'Exhibition',
  institution: 'Institution',
  reading: 'Reading',
  artist: 'Artist',
  user: 'User',
}

const EMPTY_MESSAGE: Record<TabFilter, string> = {
  all: 'No exhibitions, institutions, readings, artists or users match this search.',
  exhibition: 'No exhibitions match this search.',
  institution: 'No institutions match this search.',
  reading: 'No readings match this search.',
  artist: 'Nothing yet — check back as we add more venues.',
  user: 'No users match this search.',
}

/**
 * People come from a separate query (lib/people-search.ts) and are kept out of
 * flattenResults, which only deduplicates exhibition-side content.
 */
function userItems(data: SearchResponse): FlatItem[] {
  return (data.users ?? []).map(u => ({
    id: u.id,
    title: u.display_name,
    category: 'user' as const,
    image_url: u.avatar_url,
    url: u.url,
    is_external: false,
    subtitle: null,
    handle: u.username,
  }))
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

function Avatar({ url, name }: { url: string | null; name: string }) {
  return (
    <div className="sr-thumb sr-thumb--round">
      {url
        ? <img src={url} alt="" className="sr-thumb-img" />
        : <div className="sr-thumb-empty sr-thumb-initial">{name.charAt(0).toUpperCase()}</div>}
    </div>
  )
}

function ResultRow({ result, onClick }: { result: FlatItem; onClick?: () => void }) {
  const inner = (
    <>
      {result.category === 'user'
        ? <Avatar url={result.image_url} name={result.title} />
        : <Thumbnail url={result.image_url} />}
      <div className="sr-row-text">
        <span className="sr-row-title">
          {result.title}
          {result.is_external && <span className="sr-external-icon"> ↗</span>}
        </span>
        <span className="sr-row-category">
          {CATEGORY_LABEL[result.category]}
          {result.handle && <> &middot; @{result.handle}</>}
        </span>
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
  // The query the dropdown's items belong to, so "no matches" only shows once
  // that query has actually come back.
  const [dropdownQuery, setDropdownQuery] = useState('')
  const latestQueryRef = useRef('')
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
    latestQueryRef.current = val
    if (!val.trim() || val.length < 2) {
      setDropdownItems([])
      setDropdownQuery('')
      setIsDropdownOpen(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(val)}&mode=dropdown`)
        const data: SearchResponse = await res.json()
        // A slower, older request must not overwrite a newer one — matters now
        // that an empty answer shows a message instead of closing silently.
        if (latestQueryRef.current !== val) return
        // Content first; people last and capped.
        const all = [
          ...flattenResults(data).slice(0, 6),
          ...userItems(data).slice(0, USERS_SHOWN),
        ]
        setDropdownItems(all)
        setDropdownQuery(val)
        setIsDropdownOpen(true)
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

  const contentFlat = fullResults ? flattenResults(fullResults) : []
  const userFlat = fullResults ? userItems(fullResults) : []
  // In All, people are a capped group at the bottom; the Users tab has the rest.
  const visibleUsers =
    activeTab === 'all' ? userFlat.slice(0, USERS_SHOWN) :
    activeTab === 'user' ? userFlat :
    []
  const visibleContent =
    activeTab === 'all' ? contentFlat :
    activeTab === 'user' ? [] :
    activeTab === 'artist' ? contentFlat.filter(r => r.fromArtist) :
    contentFlat.filter(r => r.category === activeTab)
  const hiddenUserCount = activeTab === 'all' ? userFlat.length - visibleUsers.length : 0

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
            placeholder="Search by exhibition, institution, reading, artist, user"
            value={inputValue}
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            onFocus={() => {
              if (inputValue.length >= 2 && dropdownQuery === inputValue) {
                setIsDropdownOpen(true)
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />

          {/* Dropdown — shows while typing, including when on results page if input differs from current query */}
          {isDropdownOpen && dropdownQuery === inputValue && (!isFullResults || inputValue.trim() !== urlQuery) && (
            <div className="sr-dropdown">
              {dropdownItems.length === 0 ? (
                <p className="sr-dropdown-empty">
                  Nothing matches &ldquo;{dropdownQuery.trim()}&rdquo; &mdash; no exhibitions, institutions, readings, artists or users.
                </p>
              ) : (
                <>
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
                </>
              )}
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
              {(['all', 'exhibition', 'institution', 'reading', 'artist', 'user'] as TabFilter[]).map(tab => (
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
            ) : visibleUsers.length + visibleContent.length === 0 ? (
              <p className="sr-empty">{EMPTY_MESSAGE[activeTab]}</p>
            ) : (
              <div className="sr-list">
                {visibleContent.map(r => (
                  <ResultRow key={`${r.category}-${r.id}`} result={r} />
                ))}
                {visibleUsers.map(r => (
                  <ResultRow key={`${r.category}-${r.id}`} result={r} />
                ))}
                {hiddenUserCount > 0 && (
                  <button className="sr-see-all sr-see-all--inline" onClick={() => setActiveTab('user')}>
                    See all {userFlat.length} users
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
