'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import s from './EditorsPicksPage.module.css'

// ── Types ─────────────────────────────────────────────────────

interface ExhibitionPick {
  pick_id: string
  reference_id: string
  image_url: string | null
  show_title: string
  artists: string[]
  venue_name: string
}

interface ArticlePick {
  pick_id: string
  reference_id: string
  thumbnail_url: string | null
  headline: string
  author: string | null
  publication_name: string | null
  article_url: string
}

interface BookPick {
  pick_id: string
  reference_id: string
  title: string
  author: string | null
  image_url: string | null
}

interface EditorsPicksData {
  exhibition: ExhibitionPick | null
  article: ArticlePick | null
  book: BookPick | null
}

// ── Helpers ───────────────────────────────────────────────────

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(true)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)')
    setIsDesktop(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isDesktop
}

// ── Desktop layout ────────────────────────────────────────────
// All positions are percentages of the content container (1728×983 px on Paper canvas,
// where 983 = artboard height 1117 minus nav height 134).

function DesktopLayout({ exhibition, article, book }: EditorsPicksData) {
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '1728 / 983', overflow: 'visible' }}>

      {/* LEFT: Exhibition image */}
      {/* CH-0: left=36, top=170→36px below nav, w=735, h=803 */}
      {exhibition ? (
        <Link
          href={`/exhibitions/${exhibition.reference_id}`}
          style={{ position: 'absolute', left: '2.08%', top: '3.66%', width: '42.53%', height: '81.69%', display: 'block' }}
          className={s.imgLink}
        >
          {exhibition.image_url
            ? <img src={exhibition.image_url} alt={exhibition.show_title} className={s.img} />
            : <div className={s.placeholder} />
          }
        </Link>
      ) : (
        <div
          style={{ position: 'absolute', left: '2.08%', top: '3.66%', width: '42.53%', height: '81.69%' }}
          className={`${s.placeholder} ${s.placeholderEmpty}`}
        />
      )}

      {/* LEFT: Exhibition label + details */}
      {/* CT-0: top=987, CJ-0: top=1007 */}
      <div style={{ position: 'absolute', left: '2.08%', top: '86.77%', width: '42.53%' }}>
        {exhibition && (
          <>
            <p className={s.label}>Favorite Show I Saw this Week</p>
            <p className={s.meta}>
              {exhibition.show_title}<br />
              {exhibition.artists.join(', ')}<br />
              {exhibition.venue_name}
            </p>
          </>
        )}
      </div>

      {/* RIGHT TOP: Article image */}
      {/* CI-0: left=827, top=135→1px below nav, w=813, h=459 */}
      {article ? (
        <a
          href={article.article_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ position: 'absolute', left: '47.86%', top: '0.10%', width: '47.05%', height: '46.70%', display: 'block' }}
          className={s.imgLink}
        >
          {article.thumbnail_url
            ? <img src={article.thumbnail_url} alt={article.headline} className={s.img} />
            : <div className={s.placeholder} />
          }
        </a>
      ) : (
        <div
          style={{ position: 'absolute', left: '47.86%', top: '0.10%', width: '47.05%', height: '46.70%' }}
          className={`${s.placeholder} ${s.placeholderEmpty}`}
        />
      )}

      {/* RIGHT TOP: Article label + details */}
      {/* CO-0: top=604, CM-0: top=631 */}
      <div style={{ position: 'absolute', left: '47.86%', top: '47.81%', width: '47.05%' }}>
        {article && (
          <>
            <p className={s.label}>Favorite Article I Read This Week</p>
            <p className={s.meta}>
              {article.headline}<br />
              {[article.author, article.publication_name].filter(Boolean).join(', ')}
            </p>
          </>
        )}
      </div>

      {/* RIGHT BOTTOM: Book image */}
      {/* CK-0: left=827, top=702→568 below nav, w=722, h=372 */}
      <div style={{ position: 'absolute', left: '47.86%', top: '57.78%', width: '41.78%', height: '37.84%', overflow: 'hidden' }}>
        {book?.image_url
          ? <img src={book.image_url} alt={book.title} className={s.img} />
          : <div className={`${s.placeholder} ${s.placeholderBook}`} style={{ width: '100%', height: '100%' }} />
        }
      </div>

      {/* RIGHT BOTTOM: Book of the Month label + details */}
      {/* CQ-0: left=1555, top=835; CL-0: top=864 */}
      <div style={{ position: 'absolute', left: '90.0%', top: '71.31%' }}>
        {book && (
          <>
            <p className={s.label}>Book of the Month</p>
            <p className={s.meta}>
              {book.title}<br />
              {book.author}
            </p>
          </>
        )}
      </div>

    </div>
  )
}

// ── Mobile layout ─────────────────────────────────────────────

function MobileLayout({ exhibition, article, book }: EditorsPicksData) {
  return (
    <div className={s.stack}>
      <div className={s.stackItem}>
        <p className={s.label}>Favorite Show I Saw this Week</p>
        {exhibition ? (
          <Link href={`/exhibitions/${exhibition.reference_id}`} className={s.imgLink}>
            <div className={s.stackImgWrap}>
              {exhibition.image_url
                ? <img src={exhibition.image_url} alt={exhibition.show_title} className={s.img} />
                : <div className={s.placeholder} style={{ width: '100%', height: '100%' }} />
              }
            </div>
            <p className={s.meta} style={{ marginTop: 8 }}>
              {exhibition.show_title}<br />
              {exhibition.artists.join(', ')}<br />
              {exhibition.venue_name}
            </p>
          </Link>
        ) : (
          <div className={`${s.stackImgWrap} ${s.placeholderEmpty}`} />
        )}
      </div>

      <div className={s.stackItem}>
        <p className={s.label}>Favorite Article I Read This Week</p>
        {article ? (
          <a href={article.article_url} target="_blank" rel="noopener noreferrer" className={s.imgLink} style={{ display: 'block' }}>
            <div className={s.stackImgWrap}>
              {article.thumbnail_url
                ? <img src={article.thumbnail_url} alt={article.headline} className={s.img} />
                : <div className={s.placeholder} style={{ width: '100%', height: '100%' }} />
              }
            </div>
            <p className={s.meta} style={{ marginTop: 8 }}>
              {article.headline}<br />
              {[article.author, article.publication_name].filter(Boolean).join(', ')}
            </p>
          </a>
        ) : (
          <div className={`${s.stackImgWrap} ${s.placeholderEmpty}`} />
        )}
      </div>

      <div className={s.stackItem}>
        <p className={s.label}>Book of the Month</p>
        {book ? (
          <p className={s.meta}>
            {book.title}<br />
            {book.author}
          </p>
        ) : null}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────

export default function EditorsPicksPage() {
  const [data, setData] = useState<EditorsPicksData | null>(null)
  const [loading, setLoading] = useState(true)
  const isDesktop = useIsDesktop()

  useEffect(() => {
    fetch('/api/editors-picks')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const picks: EditorsPicksData = data ?? { exhibition: null, article: null, book: null }

  return (
    <div className={s.page}>
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

      <main className={s.main}>
        {loading ? (
          <div className={s.skeleton} />
        ) : isDesktop ? (
          <DesktopLayout {...picks} />
        ) : (
          <MobileLayout {...picks} />
        )}
      </main>
    </div>
  )
}
