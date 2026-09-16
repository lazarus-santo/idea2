'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The browser's Supabase client — the first one this app has actually used.
 *
 * Everything else in the codebase talks to Supabase through getSupabaseAdmin()
 * (service role, server-side only). Accounts are different: the signed-in
 * person's own session has to live in the browser to sign in at all, and their
 * profile writes go straight to Postgres under Row Level Security rather than
 * through an API route. That is the arrangement migration_v40 is written for —
 * the anon key can read public profiles and a person can update only their own
 * row, because the database says so.
 *
 * Never import lib/supabase.ts's admin client into anything a browser can
 * reach; the service role bypasses every policy in that migration.
 */
let client: SupabaseClient | null = null

export function getSupabaseBrowser(): SupabaseClient {
  if (!client) {
    client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  }
  return client
}
