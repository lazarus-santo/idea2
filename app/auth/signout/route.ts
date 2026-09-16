import { NextResponse, type NextRequest } from 'next/server'
import { getSupabaseServer } from '@/lib/supabase-server'

/**
 * Sign out. POST only, because a GET would let any image tag or prefetched
 * link on the page log somebody out without them asking.
 */
export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServer()
  await supabase.auth.signOut()

  // 303 so the browser follows with a GET rather than re-posting.
  return NextResponse.redirect(new URL('/', request.url), { status: 303 })
}
