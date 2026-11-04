import { supabaseAdmin } from '../config/supabase'
import { enqueueJobs } from '../queues/dbEmailQueue'
import { EmailJobData } from '../types'
import { computeScheduledTimes, getDailyLimit } from './warmup'

export interface TriggerConfirmationRequired {
  needs_confirmation: true
  /** Days still remaining until the scheduled send window opens */
  days_remaining: number
  /** The delay_days value configured on the next step */
  delay_days: number
  /** How many leads would be triggered */
  affected_leads: number
}

/** Why nothing was enqueued. */
export type TriggerNoSendReason = 'no_active_leads' | 'no_steps' | 'sequence_complete'

export interface TriggerSuccess {
  needs_confirmation: false
  enqueued: number
  affected_leads: number
  reason?: TriggerNoSendReason
  /** Warmup campaigns only: when the first email is scheduled, which can be well after now. */
  first_send_at?: string
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
 * Delay for each job, in order, keeping the working window, gaps and daily limit
 * of each mailbox: a burst from a new mailbox is what warmup exists to avoid.
 */
async function computeWarmupDelays(jobs: LeadJob[], sendOnWeekends: boolean): Promise<number[]> {
  const jobCounts = new Map<string, number>()
  for (const job of jobs) jobCounts.set(job.mailboxId, (jobCounts.get(job.mailboxId) ?? 0) + 1)

  const { data: mailboxes, error } = await supabaseAdmin
    .from('mailboxes')
    .select('id, warmup_started_at, daily_email_limit')
    .in('id', [...jobCounts.keys()])
  if (error) throw new Error(`Failed to load mailboxes: ${error.message}`)

  const now = new Date()
  const limits = new Map(
    ((mailboxes ?? []) as { id: string; warmup_started_at: string | null; daily_email_limit: number }[]).map((m) => [
      m.id,
      getDailyLimit(m.warmup_started_at ? new Date(m.warmup_started_at) : null, m.daily_email_limit),
    ])
  )

  const timesByMailbox = new Map<string, Date[]>()
  for (const [mailboxId, count] of jobCounts) {
    timesByMailbox.set(
      mailboxId,
      computeScheduledTimes(count, limits.get(mailboxId) ?? getDailyLimit(null), now, sendOnWeekends)
    )
  }

  return jobs.map((job) => timesByMailbox.get(job.mailboxId)!.shift()!.getTime() - now.getTime())
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
 *
 * Other campaigns send as soon as the worker picks the jobs up; warmup campaigns
 * are scheduled by computeWarmupDelays, even with force=true.
 */
export async function triggerNextSequenceStep(
  campaignId: string,
  sendOnWeekends: boolean,
  sequenceIds: string[],
  mailboxIds: string[],
  force: boolean,
  isWarmup: boolean
): Promise<TriggerNextStepResult> {
  const { data: leads, error: leadsError } = await supabaseAdmin
    .from('leads')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('status', 'active')
  if (leadsError) throw new Error(`Failed to load leads: ${leadsError.message}`)

  if (!leads || leads.length === 0) {
    return { needs_confirmation: false, enqueued: 0, affected_leads: 0, reason: 'no_active_leads' }
  }

  const leadIds = (leads as { id: string }[]).map((l) => l.id)
  const now = new Date()

  const leadsToEnqueue: LeadJob[] = []
  let maxDaysRemaining = 0
  let maxDelayDays = 0
  let hasSteps = false

  for (const sequenceId of sequenceIds) {
    const { data: steps, error: stepsError } = await supabaseAdmin
      .from('sequence_steps')
      .select('id, step_order, delay_days')
      .eq('sequence_id', sequenceId)
      .order('step_order')
    if (stepsError) throw new Error(`Failed to load sequence steps: ${stepsError.message}`)

    if (!steps || steps.length === 0) continue
    hasSteps = true

    const typedSteps = steps as { id: string; step_order: number; delay_days: number }[]
    const firstStep = typedSteps[0]
    const maxStepOrder = Math.max(...typedSteps.map((s) => s.step_order))

    // Fetch most-recent sent log per lead for this sequence (ordered desc by sent_at;
    // we take the first occurrence per lead_id to get the latest)
    const { data: emailLogs, error: logsError } = await supabaseAdmin
      .from('email_logs')
      .select('lead_id, step_id, sent_at')
      .eq('campaign_id', campaignId)
      .eq('sequence_id', sequenceId)
      .eq('status', 'sent')
      .in('lead_id', leadIds)
      .order('sent_at', { ascending: false })
    if (logsError) throw new Error(`Failed to load email logs: ${logsError.message}`)

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
    return {
      needs_confirmation: false,
      enqueued: 0,
      affected_leads: 0,
      reason: hasSteps ? 'sequence_complete' : 'no_steps',
    }
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
  const delays = isWarmup
    ? await computeWarmupDelays(leadsToEnqueue, sendOnWeekends)
    : leadsToEnqueue.map(() => 0)

  const jobs = leadsToEnqueue.map((info, idx) => ({
    name: `trigger-${info.leadId}-${info.sequenceId}-${info.stepId}`,
    data: {
      campaignId,
      sequenceId: info.sequenceId,
      stepId: info.stepId,
      leadId: info.leadId,
      mailboxId: info.mailboxId,
      sendOnWeekends,
    } satisfies EmailJobData,
    opts: { delay: delays[idx] },
  }))

  await enqueueJobs(jobs)

  return {
    needs_confirmation: false,
    enqueued: jobs.length,
    affected_leads: leadsToEnqueue.length,
    ...(isWarmup && { first_send_at: new Date(Date.now() + Math.min(...delays)).toISOString() }),
  }
}
