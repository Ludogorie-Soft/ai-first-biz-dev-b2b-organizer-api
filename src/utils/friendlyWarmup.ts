import { supabaseAdmin } from '../config/supabase'

/** Returned with HTTP 409 so clients can explain why a campaign can't start. */
export const FRIENDLY_WARMUP_PENDING = 'FRIENDLY_WARMUP_PENDING'

/** Emails of the given mailboxes that must finish friendly-contacts warmup first. */
export async function findMailboxesPendingFriendlyWarmup(mailboxIds: string[]): Promise<string[]> {
  if (mailboxIds.length === 0) return []
  const { data, error } = await supabaseAdmin
    .from('mailboxes')
    .select('email')
    .in('id', mailboxIds)
    .eq('friendly_warmup_pending', true)
  if (error) throw new Error(`Failed to check mailbox warmup: ${error.message}`)
  return ((data ?? []) as { email: string }[]).map((m) => m.email)
}

/** A mailbox awaiting friendly-contacts warmup may only send warmup campaigns. */
export async function isHeldForFriendlyWarmup(campaignId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('campaigns')
    .select('is_warmup')
    .eq('id', campaignId)
    .single()
  return !(data as { is_warmup?: boolean } | null)?.is_warmup
}

/**
 * Lets the mailboxes of a finished warmup campaign start normal sending.
 * Logs instead of throwing: the campaign has already finished, and a mailbox left
 * pending can still be cleared by hand on the Mailboxes page.
 */
export async function releaseFriendlyWarmup(campaignId: string): Promise<void> {
  const { data: links, error: linksError } = await supabaseAdmin
    .from('campaign_mailboxes')
    .select('mailbox_id')
    .eq('campaign_id', campaignId)
  if (linksError) {
    console.error('[FriendlyWarmup] Failed to load campaign mailboxes:', linksError.message)
    return
  }

  const mailboxIds = ((links ?? []) as { mailbox_id: string }[]).map((l) => l.mailbox_id)
  if (mailboxIds.length === 0) return

  const { error } = await supabaseAdmin
    .from('mailboxes')
    .update({ friendly_warmup_pending: false })
    .in('id', mailboxIds)
  if (error) {
    console.error('[FriendlyWarmup] Failed to release mailboxes:', error.message)
  }
}
