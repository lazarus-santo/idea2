// Voyage AI text embeddings, for Top Stories grouping (lib/story-groups.ts).
//
// A plain fetch rather than an SDK: it is one endpoint, called from Agent 3
// and from scripts/test-top-stories.mjs. Its one import is relative, so that
// script can still load it through ts-resolve. The fetch is watched
// (lib/ai-account.ts) so a billing or key problem reaches the admin panel.
//
// voyage-4-lite: every account's first 200M tokens are free. Agent 3 embeds
// ~20 readings a day at ~130 tokens each, so the allowance outlasts the
// project by a wide margin.

import { watchedFetch } from './ai-account'

export const EMBEDDING_MODEL = 'voyage-4-lite'

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings'
// Well under Voyage's per-request input limit; a daily Agent 3 run embeds tens.
const BATCH_SIZE = 64

const voyageFetch = watchedFetch('voyage')

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>
  usage?: { total_tokens?: number }
}

export async function embedTexts(texts: string[]): Promise<{ embeddings: number[][]; tokens: number }> {
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) throw new Error('VOYAGE_API_KEY is not set')

  const embeddings: number[][] = []
  let tokens = 0

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const res = await voyageFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      // Both sides of every comparison are the same kind of text (a headline
      // and summary), so they are embedded the same way.
      body: JSON.stringify({ input: batch, model: EMBEDDING_MODEL, input_type: 'document' }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      throw new Error(`Voyage embeddings failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
    const body = (await res.json()) as VoyageResponse
    const ordered = [...body.data].sort((a, b) => a.index - b.index)
    if (ordered.length !== batch.length) {
      throw new Error(`Voyage returned ${ordered.length} embeddings for ${batch.length} inputs`)
    }
    for (const d of ordered) embeddings.push(d.embedding)
    tokens += body.usage?.total_tokens ?? 0
  }

  return { embeddings, tokens }
}
