import { supabaseAdmin } from '../config/supabase'
import { enqueueJobs } from '../queues/dbEmailQueue'
import { EmailJobData } from '../types'

export interface TriggerConfirmationRequired {
  needs_confirmation: true
  /** Days still remaining until the scheduled send window opens */
  days_remaining: number
  /** The delay_days value configured on the next step */
  delay_days: number
  /** How many leads would be triggered */
  affected_leads: number
}

export interface TriggerSuccess {
  needs_confirmation: false
  enqueued: number
  affected_leads: number
}

export type TriggerNextStepResult = TriggerConfirmationRequired | TriggerSuccess

interface LeadJob {
  leadId: string
  sequenceId: string
  stepId: string
  mailboxId: string
  daysRemaining: number
}

/**
 * Determine the next pending step for each active lead in a campaign and
 * either enqueue immediate jobs or return a confirmation-required payload.
 *
 * Per-lead logic:
 *   - No email sent yet  → step 1, always ready (no delay check)
 *   - Last step sent     → find next step; check delay_days since last send
 *   - Sequence complete  → skip
 *
 * If force=false and any lead is still within its delay window, returns
 * TriggerConfirmationRequired so the caller can ask for user consent.
 */
export async function triggerNextSequenceStep(
  campaignId: string,
  sendOnWeekends: boolean,
  sequenceIds: string[],
  mailboxIds: string[],
  force: boolean
): Promise<TriggerNextStepResult> {
  const { data: leads } = await supabaseAdmin
    .from('leads')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('status', 'active')

  if (!leads || leads.length === 0) {
    return { needs_confirmation: false, enqueued: 0, affected_leads: 0 }
  }

  const leadIds = (leads as { id: string }[]).map((l) => l.id)
  const now = new Date()

  const leadsToEnqueue: LeadJob[] = []
  let maxDaysRemaining = 0
  let maxDelayDays = 0

  for (const sequenceId of sequenceIds) {
    const { data: steps } = await supabaseAdmin
      .from('sequence_steps')
      .select('id, step_order, delay_days')
      .eq('sequence_id', sequenceId)
      .order('step_order')

    if (!steps || steps.length === 0) continue

    const typedSteps = steps as { id: string; step_order: number; delay_days: number }[]
    const firstStep = typedSteps[0]
    const maxStepOrder = Math.max(...typedSteps.map((s) => s.step_order))

    // Fetch most-recent sent log per lead for this sequence (ordered desc by sent_at;
    // we take the first occurrence per lead_id to get the latest)
    const { data: emailLogs } = await supabaseAdmin
      .from('email_logs')
      .select('lead_id, step_id, sent_at')
      .eq('campaign_id', campaignId)
      .eq('sequence_id', sequenceId)
      .eq('status', 'sent')
      .in('lead_id', leadIds)
      .order('sent_at', { ascending: false })

    // last-sent step per lead
    const lastSentByLead = new Map<string, { stepId: string; sentAt: Date }>()
    for (const log of (emailLogs ?? []) as { lead_id: string; step_id: string; sent_at: string }[]) {
      if (!lastSentByLead.has(log.lead_id)) {
        lastSentByLead.set(log.lead_id, { stepId: log.step_id, sentAt: new Date(log.sent_at) })
      }
    }

    const stepById = new Map(typedSteps.map((s) => [s.id, s]))

    let mailboxIndex = 0

    for (const leadId of leadIds) {
      const mbId = mailboxIds[mailboxIndex % mailboxIds.length]
      mailboxIndex++

      const lastSent = lastSentByLead.get(leadId)

      if (!lastSent) {
        // Lead hasn't received any email → queue step 1 immediately
        leadsToEnqueue.push({ leadId, sequenceId, stepId: firstStep.id, mailboxId: mbId, daysRemaining: 0 })
        continue
      }

      const lastStep = stepById.get(lastSent.stepId)
      if (!lastStep || lastStep.step_order >= maxStepOrder) continue // sequence complete

      const nextStep = typedSteps.find((s) => s.step_order > lastStep.step_order)
      if (!nextStep) continue

      const scheduledAt = new Date(lastSent.sentAt.getTime() + nextStep.delay_days * 24 * 60 * 60 * 1000)
      const daysRemaining =
        scheduledAt > now ? Math.ceil((scheduledAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) : 0

      if (daysRemaining > maxDaysRemaining) maxDaysRemaining = daysRemaining
      if (nextStep.delay_days > maxDelayDays) maxDelayDays = nextStep.delay_days

      leadsToEnqueue.push({ leadId, sequenceId, stepId: nextStep.id, mailboxId: mbId, daysRemaining })
    }
  }

  if (leadsToEnqueue.length === 0) {
    return { needs_confirmation: false, enqueued: 0, affected_leads: 0 }
  }

  // If any lead is still within its delay window, ask for confirmation
  if (maxDaysRemaining > 0 && !force) {
    return {
      needs_confirmation: true,
      days_remaining: maxDaysRemaining,
      delay_days: maxDelayDays,
      affected_leads: leadsToEnqueue.length,
    }
  }

  // Enqueue all jobs — job_name is UNIQUE in the DB so double-triggers are
  // deduplicated automatically via ON CONFLICT DO NOTHING (ignoreDuplicates).
  const jobs = leadsToEnqueue.map((info) => ({
    name: `trigger-${info.leadId}-${info.sequenceId}-${info.stepId}`,
    data: {
      campaignId,
      sequenceId: info.sequenceId,
      stepId: info.stepId,
      leadId: info.leadId,
      mailboxId: info.mailboxId,
      sendOnWeekends,
    } satisfies EmailJobData,
    opts: { delay: 0 },
  }))

  await enqueueJobs(jobs)

  return { needs_confirmation: false, enqueued: jobs.length, affected_leads: leadsToEnqueue.length }
}
