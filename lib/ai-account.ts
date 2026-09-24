// Watches every Anthropic and Voyage call for account problems — billing,
// a rejected key, a usage limit — so a run can say so plainly and the admin
// panel can show it (app/api/admin/ai-status, components/admin/AiAccountBanner).
//
// WHY AT THE FETCH LAYER. In August 2026 Anthropic answered "credit balance is
// too low" for a week and nobody noticed. Agent 3 logged it as an ordinary
// classification error; Agents 1 and 2 caught it deep inside lib/claude.ts and
// logged "No title extracted from detail page". Watching the HTTP responses
// here sees the real cause whatever the calling code does with the error, and
// no catch block anywhere has to change.
//
// Every client is built with watchedFetch; finishAgentRun (lib/agent-runs.ts)
// copies what was seen during the run into agent_runs.summary.ai.
//
// The record is per server instance, not per run: two runs sharing one warm
// instance see each other's calls. That is acceptable for what it is used for —
// a billing or key problem belongs to the account, not to one run.
//
// Only relative imports and packages, so scripts/ts-resolve.mjs can load it.

import Anthropic from '@anthropic-ai/sdk'

export type AiProvider = 'anthropic' | 'voyage'

// billing: out of credit, payment required, spend limit reached
// access:  the key was rejected or the account/IP is not allowed
// limit:   Voyage's 429 — see accountProblem()
export type AiAccountProblem = 'billing' | 'access' | 'limit'

export interface AiAccountError {
  provider: AiProvider
  problem: AiAccountProblem
  status: number
  message: string
  at: string
}

export interface AiActivity {
  calls_ok: number
  account_error: AiAccountError | null
}

const BILLING_WORDS = /credit balance|billing|payment|usage limit|spend limit|free tokens|insufficient (?:funds|credit)/i

function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; detail?: unknown; message?: string }
    const message = parsed.error?.message ?? parsed.detail ?? parsed.message
    if (typeof message === 'string' && message) return message
  } catch {
    // not JSON — fall through to the raw text
  }
  return body.slice(0, 300)
}

/**
 * Which non-2xx responses are account problems rather than a bad request or a
 * passing outage.
 *
 * Anthropic: out of credit is a 400 whose message says "credit balance is too
 * low"; a spend limit is a 400 about "usage limits"; 401 and 403 are a rejected
 * key or permission. Its 429s are ordinary rate limiting that the SDK already
 * retries, so they are not flagged.
 *
 * Voyage documents no billing error at all (docs.voyageai.com/docs/error-codes,
 * checked 2026-09-22): 401 is an invalid key, 403 a forbidden IP, and 429 is
 * its only code for every kind of limit — rate, usage tier, or an account with
 * no payment method (docs/rate-limits). Agent 3 embeds a few dozen short texts
 * per run, nowhere near a real rate limit, so a 429 from Voyage is treated as
 * an account limit. 402 and billing wording are caught too in case it ever
 * sends them.
 */
export function accountProblem(provider: AiProvider, status: number, body: string): AiAccountProblem | null {
  const message = providerMessage(body)
  if (status === 402 || BILLING_WORDS.test(message)) return 'billing'
  if (status === 401 || status === 403) return 'access'
  if (provider === 'voyage' && status === 429) return 'limit'
  return null
}

// ─── The record ──────────────────────────────────────────────────────────────

interface AiEvent {
  at: number
  ok: boolean
  error: AiAccountError | null
}

const MAX_EVENTS = 2000
const events: AiEvent[] = []

function record(event: AiEvent): void {
  events.push(event)
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
}

/** What the watched clients saw since `since` (ms): successful calls, and the latest account error. */
export function aiActivitySince(since: number): AiActivity {
  let callsOk = 0
  let accountError: AiAccountError | null = null
  for (const e of events) {
    if (e.at < since) continue
    if (e.ok) callsOk++
    if (e.error) accountError = e.error
  }
  return { calls_ok: callsOk, account_error: accountError }
}

/** The latest account error since `since` (ms), or null. Loops use it to stop calling a provider that is refusing. */
export function accountErrorSince(since: number): AiAccountError | null {
  for (let i = events.length - 1; i >= 0 && events[i].at >= since; i--) {
    if (events[i].error) return events[i].error
  }
  return null
}

/** A fetch that records account problems. It looks up globalThis.fetch per call, so tests can replace it. */
export function watchedFetch(provider: AiProvider): typeof fetch {
  return async (input, init) => {
    const res = await globalThis.fetch(input, init)
    if (res.ok) {
      record({ at: Date.now(), ok: true, error: null })
      return res
    }
    const body = await res.clone().text().catch(() => '')
    const problem = accountProblem(provider, res.status, body)
    record({
      at: Date.now(),
      ok: false,
      error: problem && {
        provider,
        problem,
        status: res.status,
        message: providerMessage(body),
        at: new Date().toISOString(),
      },
    })
    return res
  }
}

/** The Anthropic client every agent uses: the usual one, watched. */
export function createAnthropic(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: watchedFetch('anthropic') })
}

// ─── Reading it back: is an agent blocked right now? ─────────────────────────
//
// Used by app/api/admin/ai-status for the admin banner. An agent's runs are
// read newest first, and the first one that SAYS something decides:
//   - summary.ai.account_error set            → blocked
//   - summary.ai.calls_ok > 0                 → fine: the provider answered
//   - no summary.ai (runs before 2026-09-22)   → blocked if an error message
//     reads like billing ("credit balance is too low" was August's), fine if
//     the run wrote something
//   - anything else (a quiet run with no AI calls) says nothing, so a quiet
//     hour never clears the warning.
// "since" is the oldest run in the unbroken blocked streak.

export interface AiRunRow {
  started_at: string
  items_succeeded: number | null
  errors: Array<{ message?: string }> | null
  summary: { ai?: { calls_ok?: number; account_error?: AiAccountError | null } } | null
}

export interface AiBlock {
  error: AiAccountError
  since: string
  last_blocked_run: string
  last_ok_run: string | null
}

// Runs before summary.ai existed. Anthropic's out-of-credit wording, and its spend limit.
const LEGACY_BILLING = /credit balance is too low|usage limits?|billing/i

// Old run errors hold the SDK's text: '400 {"type":"error","error":{...}}'.
function legacyMessage(text: string): string {
  const json = text.indexOf('{')
  return json >= 0 ? providerMessage(text.slice(json)) : text.slice(0, 300)
}

type Verdict = { kind: 'blocked'; error: AiAccountError } | { kind: 'ok' } | { kind: 'silent' }

function runVerdict(run: AiRunRow): Verdict {
  const ai = run.summary?.ai
  if (ai) {
    if (ai.account_error) return { kind: 'blocked', error: ai.account_error }
    if ((ai.calls_ok ?? 0) > 0) return { kind: 'ok' }
    return { kind: 'silent' }
  }
  const billing = (run.errors ?? []).find((e) => LEGACY_BILLING.test(e.message ?? ''))
  if (billing) {
    return {
      kind: 'blocked',
      error: { provider: 'anthropic', problem: 'billing', status: 400, message: legacyMessage(billing.message ?? ''), at: run.started_at },
    }
  }
  return (run.items_succeeded ?? 0) > 0 ? { kind: 'ok' } : { kind: 'silent' }
}

/**
 * How long one AI call may take, and how many tries it gets.
 *
 * A run's stopping points only stop NEW work, so without a limit here a single
 * call that never answers outlasts the whole run: the SDK waits 10 minutes by
 * default. `msLeft` is the time the caller has before its own hard stop, and
 * the limit is that, capped at CALL_TIMEOUT_MAX_MS.
 *
 * NO RETRIES, so the limit really is the whole call. The SDK's own retry obeys
 * a rate-limited response's retry-after header exactly, with no cap and no way
 * to interrupt the wait — "just do what it says" (client.js retryRequest).
 * A live run on 2026-09-22 was told to wait ~170s and ended at 346s, past the
 * route's 300s ceiling, with the per-attempt limit doing nothing about it.
 *
 * A call that runs out of time, or is refused, throws; the caller records it
 * like any other failed call. Nothing is saved on a guess, and the articles or
 * readings it covered are picked up by the next hourly run.
 */
export const CALL_TIMEOUT_MAX_MS = 40_000
const CALL_TIMEOUT_MIN_MS = 5_000

export function callOptions(msLeft: number): { timeout: number; maxRetries: number } {
  return {
    timeout: Math.min(CALL_TIMEOUT_MAX_MS, Math.max(CALL_TIMEOUT_MIN_MS, msLeft)),
    maxRetries: 0,
  }
}

/** runs: one agent's finished runs, newest first. Null when the agent is not blocked. */
export function currentAiBlock(runs: AiRunRow[]): AiBlock | null {
  let latest: { error: AiAccountError; run: string } | null = null
  let since: string | null = null
  let lastOk: string | null = null
  for (const run of runs) {
    const v = runVerdict(run)
    if (v.kind === 'silent') continue
    if (v.kind === 'ok') {
      lastOk = run.started_at
      break
    }
    latest ??= { error: v.error, run: run.started_at }
    since = run.started_at
  }
  if (!latest || !since) return null
  return { error: latest.error, since, last_blocked_run: latest.run, last_ok_run: lastOk }
}
