import { supabaseAdmin } from '../config/supabase'
import { computeScheduledTimes, getDailyLimit, warmedUpStartDate } from './warmup'

/**
 * Mark a mailbox as already warmed up (sends at its configured daily limit right away)
 * or restart its warmup ramp from today.
 *
 * Warmed up = warmup_started_at moved back WARMUP_DAYS, so the ramp in getDailyLimit
 * is already over. Initial-send jobs that were spread out at the warmup pace are
 * pulled forward to the new pace; "-next" follow-ups keep their schedule (it is
 * driven by the step delay, not the daily limit).
 *
 * Restarting warmup only resets the date: the sender's runtime daily-limit check
 * pushes any jobs above the new limit to the next send window.
 *
 * Returns the number of pending jobs that were moved earlier.
 */
export async function setMailboxWarmup(mailboxId: string, warmedUp: boolean): Promise<number> {
  const warmupStartedAt = warmedUp ? warmedUpStartDate() : new Date()

  const { data: mailbox, error } = await supabaseAdmin
    .from('mailboxes')
    .update({ warmup_started_at: warmupStartedAt.toISOString() })
    .eq('id', mailboxId)
    .select('id, daily_email_limit')
    .single()
  if (error || !mailbox) throw new Error(`Failed to update mailbox warmup: ${error?.message ?? 'not found'}`)

  if (!warmedUp) return 0

  const dailyLimit = getDailyLimit(warmupStartedAt, (mailbox as { daily_email_limit: number }).daily_email_limit)
  return pullForwardInitialJobs(mailboxId, dailyLimit)
}

async function pullForwardInitialJobs(mailboxId: string, dailyLimit: number): Promise<number> {
  const { data: jobs, error } = await supabaseAdmin
    .from('email_queue')
    .select('id, scheduled_at, send_on_weekends')
    .eq('mailbox_id', mailboxId)
    .eq('status', 'pending')
    // Initial sends are named "send-…-step1" (enqueueCampaignJobs) or "trigger-…"
    // (triggerNextSequenceStep); only "…-next" follow-ups are timed by the step delay.
    .not('job_name', 'like', '%-next')
    .order('scheduled_at')
  if (error) throw new Error(`Failed to load queued jobs: ${error.message}`)

  const rows = (jobs ?? []) as { id: string; scheduled_at: string; send_on_weekends: boolean }[]
  if (rows.length === 0) return 0

  // One schedule per mailbox; stay off weekends unless every queued job allows them
  const sendOnWeekends = rows.every((r) => r.send_on_weekends)
  const times = computeScheduledTimes(rows.length, dailyLimit, new Date(), sendOnWeekends)

  let moved = 0
  for (let i = 0; i < rows.length; i++) {
    // Only ever move a job earlier — never delay something already due sooner
    if (times[i].getTime() >= new Date(rows[i].scheduled_at).getTime()) continue
    const { error: updateError } = await supabaseAdmin
      .from('email_queue')
      .update({ scheduled_at: times[i].toISOString(), updated_at: new Date().toISOString() })
      .eq('id', rows[i].id)
      .eq('status', 'pending')
    if (updateError) throw new Error(`Failed to reschedule job ${rows[i].id}: ${updateError.message}`)
    moved++
  }
  return moved
}
