import { supabaseAdmin } from '../config/supabase'
import { EmailJobData } from '../types'

export interface EmailQueueRow {
  id: string
  job_name: string | null
  campaign_id: string
  sequence_id: string
  step_id: string
  lead_id: string
  mailbox_id: string
  send_on_weekends: boolean
  scheduled_at: string
  status: string
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

/**
 * Bulk-insert jobs into the DB queue.
 * Uses ON CONFLICT (job_name) DO NOTHING for idempotency — identical to BullMQ's jobId dedup.
 */
export async function enqueueJobs(
  jobs: Array<{ name: string; data: EmailJobData; opts: { delay: number } }>
): Promise<void> {
  if (jobs.length === 0) return

  const rows = jobs.map(({ name, data, opts }) => ({
    job_name: name,
    campaign_id: data.campaignId,
    sequence_id: data.sequenceId,
    step_id: data.stepId,
    lead_id: data.leadId,
    mailbox_id: data.mailboxId,
    send_on_weekends: data.sendOnWeekends,
    scheduled_at: new Date(Date.now() + Math.max(0, opts.delay)).toISOString(),
    status: 'pending',
  }))

  const { error } = await supabaseAdmin
    .from('email_queue')
    .upsert(rows, { onConflict: 'job_name', ignoreDuplicates: true })

  if (error) throw new Error(`[DB Queue] enqueueJobs failed: ${error.message}`)
}

/**
 * Enqueue a single job (convenience wrapper around enqueueJobs).
 */
export async function enqueueJob(
  name: string,
  data: EmailJobData,
  delayMs: number
): Promise<void> {
  await enqueueJobs([{ name, data, opts: { delay: delayMs } }])
}

/**
 * Claim up to batchSize due, pending jobs that belong to ACTIVE campaigns and
 * are sent from mailboxes that are NOT paused.
 *
 * Jobs of paused / completed / deleted campaigns, and of paused mailboxes (e.g.
 * auto-paused for a high bounce rate), are never selected, so they stay
 * 'pending' with their original scheduled_at and resume when the campaign or
 * mailbox is active again (and can't block other jobs meanwhile).
 *
 * Two steps:
 *   1. Select candidate job ids (due, pending, campaign active, mailbox not paused).
 *   2. Flip them to 'processing' with a conditional UPDATE ... WHERE status = 'pending'.
 *      Postgres re-checks the WHERE clause under the row lock, so if another worker
 *      claimed a row first it is simply not returned here — no double claims.
 *      The cost of a race is only a smaller batch for the losing worker.
 */
export async function claimJobs(batchSize = 5): Promise<EmailQueueRow[]> {
  const nowIso = new Date().toISOString()

  // email_queue has no FK to campaigns, so PostgREST can't join — fetch active ids first.
  const { data: activeCampaigns, error: campaignsError } = await supabaseAdmin
    .from('campaigns')
    .select('id')
    .eq('status', 'active')
  if (campaignsError) throw new Error(`[DB Queue] claimJobs failed to load campaigns: ${campaignsError.message}`)

  const activeIds = (activeCampaigns ?? []).map((c: { id: string }) => c.id)
  if (activeIds.length === 0) return []

  const { data: pausedMailboxes, error: mailboxesError } = await supabaseAdmin
    .from('mailboxes')
    .select('id')
    .eq('is_paused', true)
  if (mailboxesError) throw new Error(`[DB Queue] claimJobs failed to load mailboxes: ${mailboxesError.message}`)
  const pausedIds = (pausedMailboxes ?? []).map((m: { id: string }) => m.id)

  let candidateQuery = supabaseAdmin
    .from('email_queue')
    .select('id')
    .eq('status', 'pending')
    .lte('scheduled_at', nowIso)
    .in('campaign_id', activeIds)
  if (pausedIds.length > 0) candidateQuery = candidateQuery.not('mailbox_id', 'in', `(${pausedIds.join(',')})`)
  const { data: candidates, error: selectError } = await candidateQuery
    .order('scheduled_at')
    .limit(batchSize)
  if (selectError) throw new Error(`[DB Queue] claimJobs failed to select: ${selectError.message}`)

  const candidateIds = (candidates ?? []).map((r: { id: string }) => r.id)
  if (candidateIds.length === 0) return []

  const { data: claimed, error: updateError } = await supabaseAdmin
    .from('email_queue')
    .update({ status: 'processing', updated_at: nowIso })
    .in('id', candidateIds)
    .eq('status', 'pending')
    .select('*')
  if (updateError) throw new Error(`[DB Queue] claimJobs failed to claim: ${updateError.message}`)

  return (claimed ?? []) as EmailQueueRow[]
}

/**
 * Mark a job as successfully sent.
 */
export async function markJobSent(id: string): Promise<void> {
  await supabaseAdmin
    .from('email_queue')
    .update({ status: 'sent', updated_at: new Date().toISOString() })
    .eq('id', id)
}

/**
 * Reschedule a job for a future time without counting it as a failure attempt.
 * Used when a mailbox hits its daily/weekly send limit.
 */
export async function rescheduleJob(id: string, delayMs: number): Promise<void> {
  await supabaseAdmin
    .from('email_queue')
    .update({
      status: 'pending',
      scheduled_at: new Date(Date.now() + delayMs).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
}

/**
 * Return a claimed job to 'pending' without touching scheduled_at or attempts.
 * Used when the campaign is no longer active or the mailbox is paused: claimJobs
 * skips those jobs, so the job waits until the campaign / mailbox is resumed.
 */
export async function releaseJob(id: string): Promise<void> {
  await supabaseAdmin
    .from('email_queue')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('id', id)
}

/**
 * Delete a job outright (e.g. its campaign no longer exists).
 */
export async function deleteJob(id: string): Promise<void> {
  await supabaseAdmin.from('email_queue').delete().eq('id', id)
}

/**
 * Delete the pending jobs of leads that must not receive further emails
 * (replied, bounced, unsubscribed, opted out), so the queue only holds
 * emails that will actually be sent. Jobs already 'processing' are left
 * alone: the sender re-checks the lead status before sending.
 * Returns the number of jobs deleted.
 */
export async function deletePendingJobsForLeads(leadIds: string[]): Promise<number> {
  if (leadIds.length === 0) return 0
  const { data, error } = await supabaseAdmin
    .from('email_queue')
    .delete()
    .in('lead_id', leadIds)
    .eq('status', 'pending')
    .select('id')
  if (error) throw new Error(`[DB Queue] deletePendingJobsForLeads failed: ${error.message}`)
  return data?.length ?? 0
}

/**
 * Delete all queued jobs of a campaign.
 */
export async function deleteCampaignJobs(campaignId: string): Promise<void> {
  const { error } = await supabaseAdmin.from('email_queue').delete().eq('campaign_id', campaignId)
  if (error) throw new Error(`[DB Queue] deleteCampaignJobs failed: ${error.message}`)
}

/**
 * Handle a job failure with exponential backoff retry.
 * Mirrors BullMQ's attempts:3 + backoff:{type:'exponential',delay:5000} config.
 * Only logs to email_logs (via the caller) after all attempts are exhausted.
 */
export async function failJobWithRetry(
  job: EmailQueueRow,
  err: Error,
  maxAttempts = 3
): Promise<void> {
  const nextAttempt = job.attempts + 1
  if (nextAttempt >= maxAttempts) {
    await supabaseAdmin
      .from('email_queue')
      .update({
        status: 'failed',
        last_error: err.message,
        attempts: nextAttempt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
  } else {
    const backoffMs = 5_000 * Math.pow(2, nextAttempt)
    await supabaseAdmin
      .from('email_queue')
      .update({
        status: 'pending',
        last_error: err.message,
        attempts: nextAttempt,
        scheduled_at: new Date(Date.now() + backoffMs).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
  }
}

/**
 * Reset any jobs stuck in 'processing' longer than stuckThresholdMs.
 * Protects against rows left dangling if the process crashes mid-job.
 */
export async function resetStuckJobs(stuckThresholdMs = 5 * 60_000): Promise<void> {
  const threshold = new Date(Date.now() - stuckThresholdMs).toISOString()
  await supabaseAdmin
    .from('email_queue')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'processing')
    .lt('updated_at', threshold)
}
