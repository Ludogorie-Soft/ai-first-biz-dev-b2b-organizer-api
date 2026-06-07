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
 * Atomically claim up to batchSize pending jobs that are due.
 * Calls the claim_email_jobs Postgres function which uses FOR UPDATE SKIP LOCKED
 * so concurrent workers never double-claim a row.
 */
export async function claimJobs(batchSize = 5): Promise<EmailQueueRow[]> {
  const { data, error } = await supabaseAdmin.rpc('claim_email_jobs', {
    batch_limit: batchSize,
  })
  if (error) throw new Error(`[DB Queue] claimJobs failed: ${error.message}`)
  return (data ?? []) as EmailQueueRow[]
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
