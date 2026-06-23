'use client'

import { useState, useEffect } from 'react'
import type { Preread } from '@/lib/types'

function publicationDomain(url: string | null): string | null {
  if (!url) return null
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return null }
}

function TextPlaceholder({ label }: { label: string }) {
  return (
    <div className="preread-thumb preread-thumb--placeholder" aria-hidden="true">
      <span className="preread-thumb-label">{label}</span>
    </div>
  )
}

function PublicationLogo({ articleUrl, fallbackLabel }: { articleUrl: string; fallbackLabel: string }) {
  const [failed, setFailed] = useState(false)
  const domain = publicationDomain(articleUrl)

  if (!domain || failed) return <TextPlaceholder label={fallbackLabel} />

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://logo.clearbit.com/${domain}`}
      alt=""
      className="preread-thumb preread-thumb--logo"
      onError={() => setFailed(true)}
    />
  )
}

interface PrereadCardProps {
  preread: Preread
  placeholderLabel: string
}

export default function PrereadCard({ preread, placeholderLabel }: PrereadCardProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(preread.thumbnail_url ?? null)
  const [imgFailed, setImgFailed] = useState(false)

  useEffect(() => {
    if (imageUrl || !preread.article_url) return
    fetch(`/api/og-image?url=${encodeURIComponent(preread.article_url)}`)
      .then((r) => r.json())
      .then((d) => { if (d.image_url) setImageUrl(d.image_url) })
      .catch(() => {})
  }, [preread.article_url, imageUrl])

  const hasImage = imageUrl && !imgFailed

  return (
    <div className="preread">
      <div className="preread-inner">
        <div className="preread-thumb-wrap">
          {hasImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt=""
              className="preread-thumb"
              onError={() => setImgFailed(true)}
            />
          ) : preread.article_url ? (
            <PublicationLogo articleUrl={preread.article_url} fallbackLabel={placeholderLabel} />
          ) : (
            <TextPlaceholder label={placeholderLabel} />
          )}
        </div>
        <div className="preread-text">
          {preread.article_title && <h3 className="preread-title">{preread.article_title}</h3>}
          {preread.publication && <p className="preread-publication">{preread.publication}</p>}
          <p className="preread-summary">{preread.summary}</p>
          {preread.article_url && (
            <a
              href={preread.article_url}
              target="_blank"
              rel="noopener noreferrer"
              className="preread-source"
            >
              Read more →
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
