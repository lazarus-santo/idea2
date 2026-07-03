// Shared taxonomy constants for Agent 2 (Prereads Generator) and Agent 3
// (Readings Curator) classification logic.

export const MAJOR_MUSEUMS = [
  // USA
  'MoMA', 'Museum of Modern Art',
  'Whitney Museum',
  'Guggenheim',
  'Metropolitan Museum', 'The Met',
  'LACMA', 'Los Angeles County Museum',
  'SFMOMA', 'San Francisco Museum of Modern Art',
  'Art Institute of Chicago',
  'Walker Art Center',
  'ICA Boston', 'Institute of Contemporary Art Boston',
  // Europe
  'Tate Modern', 'Tate Britain',
  'Centre Pompidou',
  'Stedelijk Museum',
  'Kunsthaus Zürich',
  'Hamburger Bahnhof',
  'Fondazione Prada',
  'Palazzo Grassi',
  'Serpentine',
  'Whitechapel Gallery',
  'Hayward Gallery',
  // Global
  'National Gallery of Australia',
  'Mori Art Museum',
  'Museum of Contemporary Art Tokyo',
  'Fondación Jumex',
]

export const SIGNIFICANT_INSTITUTION_SIGNALS = [
  'director', 'chief curator', 'curator',
  'appointed', 'named', 'steps down',
  'resigns', 'departs', 'joins',
  'solo exhibition', 'solo show',
  'retrospective', 'survey show',
]

export function mentionsMajorMuseum(text: string): boolean {
  const lower = text.toLowerCase()
  return MAJOR_MUSEUMS.some((m) => lower.includes(m.toLowerCase()))
}
