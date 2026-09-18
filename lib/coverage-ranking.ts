// Museum and fair coverage ranking — shared by the generator (lib/museum-coverage.ts)
// and the public page (lib/coverage-display.ts), so the order coverage is chosen in
// and the order it is shown in come from one list. Kept free of the Anthropic/Exa
// clients museum-coverage.ts creates at import, so the page can load it.

// Order matters — the publication-importance ranking for Type C-Large and fairs
// (Artforum > Hyperallergic > NYT > ARTnews > The Art Newspaper > Artnet > New Yorker
// > Frieze > Brooklyn Rail > FT).
export const MUSEUM_TARGET_DOMAINS = [
  'artforum.com', 'hyperallergic.com', 'nytimes.com', 'artnews.com',
  'theartnewspaper.com', 'news.artnet.com', 'newyorker.com', 'frieze.com',
  'brooklynrail.org', 'ft.com',
]

// Same hostname-minus-www normalisation as getResultDomain in lib/claude.ts.
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

export function publicationImportanceRank(url: string): number {
  const host = hostOf(url)
  const idx = MUSEUM_TARGET_DOMAINS.findIndex((d) => host === d || host.endsWith(`.${d}`))
  return idx === -1 ? MUSEUM_TARGET_DOMAINS.length : idx
}
