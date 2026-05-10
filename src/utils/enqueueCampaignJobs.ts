import { supabaseAdmin } from '../config/supabase'
import { emailQueue } from '../queues/emailQueue'
import { getDailyLimit, computeScheduledTimes } from './warmup'
import { EmailJobData } from '../types'

/**
 * Enqueue step-1 email jobs for a list of leads in an active campaign.
 * Called when:
 *   1. Leads are imported into an already-active campaign.
 *   2. A campaign transitions from pending_mailbox_approval → active (admin approval).
 */
export async function enqueueCampaignJobs(
  campaignId: string,
  leadIds: string[]
): Promise<number> {
  if (leadIds.length === 0) return 0

  const { data: campaign } = await supabaseAdmin
    .from('campaigns')
    .select('id, send_on_weekends, campaign_sequences(sequence_id), campaign_mailboxes(mailbox_id)')
    .eq('id', campaignId)
    .single()

  if (!campaign) return 0

  const sendOnWeekends = Boolean(
    (campaign as { send_on_weekends?: boolean }).send_on_weekends
  )

  const sequenceIds = (campaign.campaign_sequences as { sequence_id: string }[]).map(
    (s) => s.sequence_id
  )
  const mailboxIds = (campaign.campaign_mailboxes as { mailbox_id: string }[]).map(
    (m) => m.mailbox_id
  )

  if (sequenceIds.length === 0 || mailboxIds.length === 0) return 0

  const { data: mailboxRows } = await supabaseAdmin
    .from('mailboxes')
    .select('id, warmup_started_at, is_paused, daily_email_limit')
    .in('id', mailboxIds)

  const mailboxMap = new Map(
    (mailboxRows ?? []).map(
      (m: { id: string; warmup_started_at: string; is_paused: boolean; daily_email_limit: number }) => [
        m.id,
        { warmupStartedAt: new Date(m.warmup_started_at), isPaused: m.is_paused, dailyEmailLimit: m.daily_email_limit },
      ]
    )
  )

  let totalEnqueued = 0

  for (const sequenceId of sequenceIds) {
    const { data: firstStep } = await supabaseAdmin
      .from('sequence_steps')
      .select('id, delay_days')
      .eq('sequence_id', sequenceId)
      .order('step_order')
      .limit(1)
      .single()

    if (!firstStep) continue

    const sendImmediately = (firstStep as { delay_days: number }).delay_days === 0

    // Distribute leads round-robin across mailboxes
    const mailboxLeads = new Map<string, string[]>()
    leadIds.forEach((leadId, idx) => {
      const mbId = mailboxIds[idx % mailboxIds.length]
      if (!mailboxLeads.has(mbId)) mailboxLeads.set(mbId, [])
      mailboxLeads.get(mbId)!.push(leadId)
    })

    const jobs: Array<{ name: string; data: EmailJobData; opts: { delay: number } }> = []

    for (const [mbId, mbLeads] of mailboxLeads) {
      const mbInfo = mailboxMap.get(mbId)
      if (mbInfo?.isPaused) continue

      let scheduledTimes: Date[]
      if (sendImmediately) {
        scheduledTimes = mbLeads.map(() => new Date())
      } else {
        const dailyLimit = getDailyLimit(mbInfo?.warmupStartedAt ?? null, mbInfo?.dailyEmailLimit)
        scheduledTimes = computeScheduledTimes(
          mbLeads.length,
          dailyLimit,
          new Date(),
          sendOnWeekends
        )
      }

      mbLeads.forEach((leadId, idx) => {
        const delayMs = Math.max(0, scheduledTimes[idx].getTime() - Date.now())
        jobs.push({
          name: `send-${leadId}-${sequenceId}-step1`,
          data: {
            campaignId,
            sequenceId,
            stepId: (firstStep as { id: string }).id,
            leadId,
            mailboxId: mbId,
            sendOnWeekends,
          } satisfies EmailJobData,
          opts: { delay: delayMs },
        })
      })
    }

    if (jobs.length > 0) {
      await emailQueue.addBulk(jobs)
      totalEnqueued += jobs.length
    }
  }

  return totalEnqueued
}
