import 'server-only'

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A Supabase client for the current request, carrying the signed-in person's
 * session from their cookies.
 *
 * This is the anon key plus their JWT, so every read and write is filtered by
 * the policies in migration_v40 — a private profile is invisible here in the
 * same way it is invisible in the browser. Use it for anything about the
 * person making the request. getSupabaseAdmin() (lib/supabase.ts) bypasses all
 * of that and stays reserved for the agents and admin routes.
 *
 * A NEW CLIENT PER REQUEST, never a module-level singleton: the client holds
 * that one person's tokens, so sharing it across requests would hand one
 * visitor another visitor's session.
 */
export async function getSupabaseServer(): Promise<SupabaseClient> {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          // Server Components cannot write cookies — Next throws here. That is
          // expected and harmless: proxy.ts runs before every page render and
          // writes refreshed tokens to the response itself, so the only thing
          // lost by swallowing this is a duplicate write. Route Handlers and
          // Server Actions CAN write, and do land here.
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          } catch {
            // Rendering a Server Component; proxy.ts handles the refresh.
          }
        },
      },
    }
  )
}
