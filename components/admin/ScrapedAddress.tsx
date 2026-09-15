'use client'

import type { CSSProperties } from 'react'

// What Agent 1 recorded for where a show is (exhibitions.show_location, _2, _3),
// and which addresses the public site is actually showing. Lets a reviewer tell
// addresses found on the show's own pages from the venue fallback, and gives an
// address_error flag something concrete to judge against.

const F = 'var(--font-inter-tight), system-ui, sans-serif'

export type ShowLocationSource = 'show' | 'venue' | null
export type ResolvedLocationSource = 'override' | 'show' | 'venue' | null

const labelStyle: CSSProperties = {
  display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: 'rgba(0,0,0,0.4)', marginBottom: 4, fontFamily: F,
}

function chip(background: string, color: string): CSSProperties {
  return {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
    padding: '2px 6px', background, color, whiteSpace: 'nowrap',
  }
}

const SITE_SOURCE_LABEL: Record<Exclude<ResolvedLocationSource, null>, string> = {
  override: 'your address override',
  show: 'the scraped show address',
  venue: 'the venue address',
}

export default function ScrapedAddress({
  showLocations,
  showLocationNeighborhood,
  showLocationSource,
  resolvedAddresses,
  resolvedSource,
  addressError,
}: {
  /** show_location, _2, _3 — the populated ones, in order. */
  showLocations: string[]
  showLocationNeighborhood: string | null
  showLocationSource: ShowLocationSource
  resolvedAddresses: string[]
  resolvedSource: ResolvedLocationSource
  addressError: boolean
}) {
  return (
    <div style={{ fontFamily: F, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={labelStyle}>
        Scraped show address{showLocations.length > 1 ? `es (${showLocations.length} locations)` : ''}
      </label>

      {showLocations.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {showLocations.map((address, i) => (
            <div key={address} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 13, color: '#000' }}>
              <span>
                {address}
                {/* Neighborhood and coordinates belong to the first address only. */}
                {i === 0 && showLocationNeighborhood ? ` · ${showLocationNeighborhood}` : ''}
              </span>
              {i === 0 && (showLocationSource === 'show' ? (
                <span style={chip('#dcfce7', '#166534')}>Found on show pages</span>
              ) : (
                <span style={chip('rgba(0,0,0,0.06)', 'rgba(0,0,0,0.55)')}>Venue fallback — no show address found</span>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.45)' }}>
          None recorded — scraped before show addresses were collected, or Agent 1 couldn&apos;t place it
        </div>
      )}

      {addressError && (
        <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', padding: '6px 8px' }}>
          Address error: the addresses Agent 1 found conflict, or one came back garbled. What&apos;s
          shown above comes from the show&apos;s own page; a conflicting address from the listing page
          isn&apos;t stored, so check the gallery&apos;s site before approving.
        </div>
      )}

      <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
        On the site: {resolvedAddresses.length > 0 ? resolvedAddresses.join(' · ') : 'no address'}
        {resolvedSource ? ` (${SITE_SOURCE_LABEL[resolvedSource]})` : ''}
      </div>
    </div>
  )
}
