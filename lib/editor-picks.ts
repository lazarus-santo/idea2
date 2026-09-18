import { getSupabaseAdmin } from './supabase'

export type PickType = 'exhibition' | 'article' | 'book'

// editor_picks.reference_id is a bare uuid: no foreign key, and which table it
// points into depends on pick_type. That mapping lives nowhere but here.
export const PICK_TARGET_TABLE: Record<PickType, 'exhibitions' | 'readings' | 'seed_books'> = {
  exhibition: 'exhibitions',
  article: 'readings',
  book: 'seed_books',
}

export interface PickRef {
  id: string
  status: string
}

/**
 * Every reference_id held by editor_picks rows of one type, live and retired
 * alike. Deletes that can reach the target table exclude these ids so a pick is
 * never left pointing at a row that no longer exists.
 *
 * Retired picks count too. Only the live pick renders, but a retired pick is the
 * record of what was once chosen, and a dangling one cannot be repaired after the
 * fact: reference_id is all there is — no cached title, no stored URL.
 *
 * Errors are returned, not thrown. A caller that cannot read this list must not
 * fall back to deleting blind.
 */
export async function pickedReferenceIds(
  pickType: PickType
): Promise<{ ids: string[]; error: string | null }> {
  const { data, error } = await getSupabaseAdmin()
    .from('editor_picks')
    .select('reference_id')
    .eq('pick_type', pickType)

  if (error) return { ids: [], error: error.message }

  const ids = (data ?? []).map((p) => p.reference_id as string).filter(Boolean)
  return { ids: [...new Set(ids)], error: null }
}

/**
 * The picks, if any, pointing at one row — so a delete can be refused with a
 * reason that names them.
 */
export async function picksReferencing(
  pickType: PickType,
  referenceId: string
): Promise<{ picks: PickRef[]; error: string | null }> {
  const { data, error } = await getSupabaseAdmin()
    .from('editor_picks')
    .select('id, status')
    .eq('pick_type', pickType)
    .eq('reference_id', referenceId)

  if (error) return { picks: [], error: error.message }
  return { picks: (data ?? []) as PickRef[], error: null }
}

/**
 * Whether a reference_id resolves in the table its pick_type points into.
 *
 * Checked before a pick is created: /api/editors-picks looks its target up fresh
 * on every request and omits whatever it cannot find, so an unresolvable
 * reference_id produces a pick that renders as nothing, with no error anywhere.
 *
 * A malformed uuid surfaces as a lookup error rather than a false negative — the
 * caller should reject on either.
 */
export async function pickTargetExists(
  pickType: PickType,
  referenceId: string
): Promise<{ exists: boolean; error: string | null }> {
  const { data, error } = await getSupabaseAdmin()
    .from(PICK_TARGET_TABLE[pickType])
    .select('id')
    .eq('id', referenceId)
    .maybeSingle()

  if (error) return { exists: false, error: error.message }
  return { exists: !!data, error: null }
}
