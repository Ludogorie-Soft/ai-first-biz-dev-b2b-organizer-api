import { supabaseAdmin } from '../config/supabase'
import { HARD_BOUNCE_THRESHOLD } from './warmup'
import { deletePendingJobsForLeads } from '../queues/dbEmailQueue'

export interface HardBounceResult {
  /** Leads whose primary email bounced: now status 'bounced', no further sequence emails. */
  bouncedLeadIds: string[]
  /** Leads whose office email bounced: office_email cleared, primary email keeps receiving. */
  clearedOfficeLeadIds: string[]
  /** Campaigns of the affected leads, for completion checks. */
  campaignIds: string[]
}

export const BOUNCE_WINDOW_DAYS = 30
export const PAUSED_REASON_HIGH_BOUNCE_RATE = 'high_bounce_rate'

/**
 * Pauses the mailbox when its hard-bounce rate over the last 30 days exceeds
 * the threshold, recording the reason and numbers for the UI.
 *
 * Only emails sent after bounce_check_since count: when an admin resumes a
 * mailbox, the bounces that caused the pause do not pause it again.
 * An already paused mailbox is left as it is.
 */
export async function checkAndPauseIfNeeded(mailboxId: string): Promise<void> {
  const { data: mailbox } = await supabaseAdmin
    .from('mailboxes')
    .select('is_paused, bounce_check_since')
    .eq('id', mailboxId)
    .maybeSingle()
  if (!mailbox) return
  const mb = mailbox as { is_paused: boolean; bounce_check_since: string | null }
  if (mb.is_paused) return

  const windowStart = new Date(Date.now() - BOUNCE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const since =
    mb.bounce_check_since && new Date(mb.bounce_check_since) > windowStart
      ? new Date(mb.bounce_check_since)
      : windowStart

  const { data: logs } = await supabaseAdmin
    .from('email_logs')
    .select('status')
    .eq('mailbox_id', mailboxId)
    .in('status', ['sent', 'bounced'])
    .gte('created_at', since.toISOString())

  if (!logs || logs.length < 10) return // not enough data yet

  const bounced = logs.filter((l: { status: string }) => l.status === 'bounced').length
  const rate = bounced / logs.length

  if (rate > HARD_BOUNCE_THRESHOLD) {
    await supabaseAdmin
      .from('mailboxes')
      .update({
        is_paused: true,
        paused_reason: PAUSED_REASON_HIGH_BOUNCE_RATE,
        paused_at: new Date().toISOString(),
        paused_bounce_rate: Number(rate.toFixed(4)),
        paused_bounced_count: bounced,
        paused_total_count: logs.length,
      })
      .eq('id', mailboxId)
      .eq('is_paused', false)
    console.warn(
      `[Bounce] Mailbox ${mailboxId} paused — hard bounce rate ${(rate * 100).toFixed(1)}% (${bounced}/${logs.length}) exceeds ${HARD_BOUNCE_THRESHOLD * 100}% threshold`
    )
  }
}

/**
 * Marks the sent email logs to `email` for these leads as bounced and returns
 * the mailboxes involved. Logs written before recipient_email existed are
 * matched by falling back to the lead's latest sent log.
 */
async function markLogsBounced(leadIds: string[], email: string, fallbackToLatest: boolean): Promise<Set<string>> {
  const mailboxIds = new Set<string>()
  if (leadIds.length === 0) return mailboxIds

  const { data: updated } = await supabaseAdmin
    .from('email_logs')
    .update({ status: 'bounced' })
    .in('lead_id', leadIds)
    .eq('status', 'sent')
    .eq('recipient_email', email)
    .select('lead_id, mailbox_id')

  const rows = (updated ?? []) as { lead_id: string; mailbox_id: string }[]
  for (const row of rows) mailboxIds.add(row.mailbox_id)

  if (fallbackToLatest) {
    const matched = new Set(rows.map((r) => r.lead_id))
    for (const leadId of leadIds.filter((id) => !matched.has(id))) {
      const { data: log } = await supabaseAdmin
        .from('email_logs')
        .select('id, mailbox_id')
        .eq('lead_id', leadId)
        .eq('status', 'sent')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!log) continue
      const typed = log as { id: string; mailbox_id: string }
      await supabaseAdmin.from('email_logs').update({ status: 'bounced' }).eq('id', typed.id)
      mailboxIds.add(typed.mailbox_id)
    }
  }

  return mailboxIds
}

/**
 * Records that `email` is invalid (permanent bounce).
 *
 * - Leads with it as primary email become 'bounced', so the sender skips all
 *   their remaining sequence steps.
 * - Leads with it only as office email get office_email cleared, so later
 *   steps still go to their primary email but not to the invalid address.
 *
 * Idempotent: a lead already 'bounced', or an office email already cleared,
 * is left alone, so processing the same bounce again changes nothing.
 *
 * Without companyId it applies to every company (SES notifications carry no
 * company); with it, only to that company's leads.
 */
export async function recordHardBounce(
  rawEmail: string,
  opts: { companyId?: string } = {}
): Promise<HardBounceResult> {
  const email = rawEmail.trim().toLowerCase()
  const result: HardBounceResult = { bouncedLeadIds: [], clearedOfficeLeadIds: [], campaignIds: [] }
  if (!email.includes('@')) return result

  const campaignIds = new Set<string>()
  const mailboxIds = new Set<string>()

  // Primary email
  let primaryQuery = supabaseAdmin
    .from('leads')
    .update({ status: 'bounced' })
    .eq('email', email)
    .neq('status', 'bounced')
  if (opts.companyId) primaryQuery = primaryQuery.eq('company_id', opts.companyId)
  const { data: bouncedLeads, error: primaryError } = await primaryQuery.select('id, campaign_id')
  if (primaryError) throw new Error(`Failed to mark leads bounced: ${primaryError.message}`)

  const bounced = (bouncedLeads ?? []) as { id: string; campaign_id: string | null }[]
  result.bouncedLeadIds = bounced.map((l) => l.id)
  for (const l of bounced) if (l.campaign_id) campaignIds.add(l.campaign_id)
  for (const id of await markLogsBounced(result.bouncedLeadIds, email, true)) mailboxIds.add(id)
  await deletePendingJobsForLeads(result.bouncedLeadIds)

  // Office email
  let officeQuery = supabaseAdmin
    .from('leads')
    .update({ office_email: null })
    .eq('office_email', email)
    .neq('email', email)
  if (opts.companyId) officeQuery = officeQuery.eq('company_id', opts.companyId)
  const { data: officeLeads, error: officeError } = await officeQuery.select('id, campaign_id')
  if (officeError) throw new Error(`Failed to clear office emails: ${officeError.message}`)

  const office = (officeLeads ?? []) as { id: string; campaign_id: string | null }[]
  result.clearedOfficeLeadIds = office.map((l) => l.id)
  for (const l of office) if (l.campaign_id) campaignIds.add(l.campaign_id)
  for (const id of await markLogsBounced(result.clearedOfficeLeadIds, email, false)) mailboxIds.add(id)

  for (const mailboxId of mailboxIds) await checkAndPauseIfNeeded(mailboxId)

  result.campaignIds = [...campaignIds]
  return result
}
