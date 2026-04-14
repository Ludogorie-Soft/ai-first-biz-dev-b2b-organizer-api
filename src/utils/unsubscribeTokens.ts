import { supabaseAdmin } from '../config/supabase'

interface UnsubscribeTokenRecord {
  token: string
}

export async function ensureUnsubscribeTokens(
  rows: Array<{ lead_id: string; company_id: string }>
): Promise<void> {
  if (rows.length === 0) return

  const { error } = await supabaseAdmin
    .from('unsubscribe_tokens')
    .upsert(rows, { onConflict: 'lead_id', ignoreDuplicates: false })

  if (error) {
    throw new Error(`Failed to ensure unsubscribe tokens: ${error.message}`)
  }
}

export async function ensureUnsubscribeToken(
  leadId: string,
  companyId: string
): Promise<UnsubscribeTokenRecord> {
  const { data, error } = await supabaseAdmin
    .from('unsubscribe_tokens')
    .upsert({ lead_id: leadId, company_id: companyId }, { onConflict: 'lead_id', ignoreDuplicates: false })
    .select('token')
    .single<UnsubscribeTokenRecord>()

  if (error || !data?.token) {
    throw new Error(
      `Failed to resolve unsubscribe token for lead ${leadId}: ${error?.message ?? 'token missing after upsert'}`
    )
  }

  return data
}
