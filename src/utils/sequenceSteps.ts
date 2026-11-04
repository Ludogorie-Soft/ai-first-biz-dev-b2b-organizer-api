import { supabaseAdmin } from '../config/supabase'

/** Returned with HTTP 400 so clients can explain why a campaign can't start. */
export const SEQUENCE_HAS_NO_STEPS = 'SEQUENCE_HAS_NO_STEPS'

/**
 * Names of the given sequences that have no steps. Only steps are ever sent: a
 * template uploaded to a sequence goes out once a step uses it.
 */
export async function findSequencesWithoutSteps(
  sequenceIds: string[],
  companyId: string
): Promise<string[]> {
  if (sequenceIds.length === 0) return []
  const { data, error } = await supabaseAdmin
    .from('sequences')
    .select('name, sequence_steps(id)')
    .in('id', sequenceIds)
    .eq('company_id', companyId)
  if (error) throw new Error(`Failed to check sequence steps: ${error.message}`)
  return ((data ?? []) as { name: string; sequence_steps: { id: string }[] }[])
    .filter((s) => s.sequence_steps.length === 0)
    .map((s) => s.name)
}
