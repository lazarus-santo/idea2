import type Exa from 'exa-js'
import { getSupabaseAdmin } from './supabase'

// Every real exa.search() call site in the codebase routes through here — see
// migration_v37 for the exa_search_log table this writes to. The point is
// visibility into cost, request ids, and (critically) real failures that the
// codebase's existing `.catch(() => ({ results: [] as unknown[] }))` pattern
// silently discarded everywhere it appeared.

// Deliberately narrow rather than reusing Exa's own overloaded
// RegularSearchOptions generic — every real call site in this codebase passes
// only these fields. Matches the existing style throughout lib/claude.ts and
// lib/museum-coverage.ts of not fighting the SDK's types, just re-casting.
export interface LoggedExaSearchOptions {
  type?: 'auto' | 'neural' | 'keyword'
  numResults?: number
  includeDomains?: string[]
  startPublishedDate?: string
  contents?: { highlights?: boolean }
}

export interface LoggedExaSearchContext {
  // Nullable/optional, not defaulted to a fake id — some call sites (solo's
  // per-artist searches, in code paths that don't thread exhibition context
  // all the way down) genuinely have no exhibition id available yet.
  exhibitionId?: string | null
  functionName: string
}

// Same {results: [...]} shape every caller's old `.catch(() => ({ results: [] as
// unknown[] }))` already returned on failure — callers re-cast this the same way
// they always did (`as unknown as PoolResult[]` / `as unknown as
// MuseumSearchResult[]`), so no caller's control flow needs to change beyond the
// call site itself.
export interface LoggedExaSearchResult {
  results: unknown[]
}

// Logging must never break search functionality — this is the one function in
// this file allowed to swallow an error outright, and it's the only thing that
// does. Awaited (not fire-and-forget) so a log write actually completes before
// a serverless function's execution can be frozen, but its own failure is
// caught here and never propagates.
async function logSearch(row: {
  exhibitionId: string | null
  functionName: string
  queryText: string
  resultCount: number | null
  costDollars: number | null
  requestId: string | null
  error: string | null
}): Promise<void> {
  try {
    await getSupabaseAdmin().from('exa_search_log').insert({
      exhibition_id: row.exhibitionId,
      function_name: row.functionName,
      query_text: row.queryText,
      result_count: row.resultCount,
      cost_dollars: row.costDollars,
      request_id: row.requestId,
      error: row.error,
    })
  } catch {
    // Swallowed on purpose — a logging failure must not be indistinguishable
    // from a search failure, and must never surface to the caller.
  }
}

export async function loggedExaSearch(
  exa: Exa,
  query: string,
  options: LoggedExaSearchOptions,
  context: LoggedExaSearchContext
): Promise<LoggedExaSearchResult> {
  const exhibitionId = context.exhibitionId ?? null

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await exa.search(query, options as any)
    await logSearch({
      exhibitionId,
      functionName: context.functionName,
      queryText: query,
      resultCount: response.results.length,
      costDollars: response.costDollars?.total ?? null,
      requestId: response.requestId ?? null,
      error: null,
    })
    return { results: response.results }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logSearch({
      exhibitionId,
      functionName: context.functionName,
      queryText: query,
      resultCount: null,
      costDollars: null,
      requestId: null,
      error: message,
    })
    return { results: [] }
  }
}
