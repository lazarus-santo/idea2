const TIER_1 = [
  'artforum', 'frieze', 'hyperallergic', 'the art newspaper', 'art newspaper',
  'the new yorker', 'new yorker',
]

const TIER_2 = [
  'new york times', 'nyt', 'the guardian', 'guardian', 'financial times', 'ft',
  'highsnobiety', '032c', 'artnews', 'art in america', 'artnet news', 'artnet',
  'the art newspaper', 'flash art', 'mousse',
]

export function publicationTier(publication: string | null): 1 | 2 | 3 {
  if (!publication) return 3
  const p = publication.toLowerCase()
  if (TIER_1.some((t) => p.includes(t))) return 1
  if (TIER_2.some((t) => p.includes(t))) return 2
  return 3
}

export function sortByTier<T extends { publication?: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => publicationTier(a.publication ?? null) - publicationTier(b.publication ?? null))
}
