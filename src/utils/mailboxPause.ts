import { supabaseAdmin } from '../config/supabase'
import { computeScheduledTimes, getDailyLimit } from './warmup'

/** Pause fields returned to the UI so it can explain why a mailbox is paused. */
export const MAILBOX_PAUSE_FIELDS =
  'is_paused, paused_reason, paused_at, paused_bounce_rate, paused_bounced_count, paused_total_count'

export interface ResumeResult {
  /** Overdue queued emails spread out again over the send window. */
  rescheduled_jobs: number
}

/**
 * Resumes a paused mailbox (global admin action).
 *
 * - Clears the pause and its reason.
 * - Sets bounce_check_since to now, so the bounce-rate check only counts
 *   emails sent from now on and the old bounces do not pause it again.
 * - Emails that became due while paused would otherwise all go out at once;
 *   they are spread over the working window with the usual gaps and daily
 *   limit. Emails scheduled for later keep their time.
 *
 * Returns null when the mailbox does not exist.
 */
export async function resumeMailbox(mailboxId: string): Promise<ResumeResult | null> {
  const now = new Date()

  const { data: mailbox, error } = await supabaseAdmin
    .from('mailboxes')
    .update({
      is_paused: false,
      paused_reason: null,
      paused_at: null,
      paused_bounce_rate: null,
      paused_bounced_count: null,
      paused_total_count: null,
      bounce_check_since: now.toISOString(),
    })
    .eq('id', mailboxId)
    .select('id, warmup_started_at, daily_email_limit')
    .maybeSingle()
  if (error) throw new Error(`Failed to resume mailbox: ${error.message}`)
  if (!mailbox) return null

  const mb = mailbox as { warmup_started_at: string | null; daily_email_limit: number }
  const dailyLimit = getDailyLimit(mb.warmup_started_at ? new Date(mb.warmup_started_at) : null, mb.daily_email_limit)

  const { data: jobs, error: jobsError } = await supabaseAdmin
    .from('email_queue')
    .select('id, send_on_weekends')
    .eq('mailbox_id', mailboxId)
    .eq('status', 'pending')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at')
  if (jobsError) throw new Error(`Failed to load queued jobs: ${jobsError.message}`)

  const rows = (jobs ?? []) as { id: string; send_on_weekends: boolean }[]
  if (rows.length === 0) return { rescheduled_jobs: 0 }

  // One schedule for the mailbox; stay off weekends unless every job allows them
  const sendOnWeekends = rows.every((r) => r.send_on_weekends)
  const times = computeScheduledTimes(rows.length, dailyLimit, now, sendOnWeekends)

  let rescheduled = 0
  for (let i = 0; i < rows.length; i++) {
    const { error: updateError } = await supabaseAdmin
      .from('email_queue')
      .update({ scheduled_at: times[i].toISOString(), updated_at: new Date().toISOString() })
      .eq('id', rows[i].id)
      .eq('status', 'pending')
    if (updateError) throw new Error(`Failed to reschedule job ${rows[i].id}: ${updateError.message}`)
    rescheduled++
  }
  return { rescheduled_jobs: rescheduled }
}
