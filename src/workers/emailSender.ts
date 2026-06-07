import { SendEmailCommand } from '@aws-sdk/client-ses'
import { sesClient } from '../config/ses'
import { supabaseAdmin } from '../config/supabase'
import { mergeVars } from '../utils/mergeVars'
import { getDailyLimit, delayMsForNextStep, msUntilNextDaySendWindow } from '../utils/warmup'
import { ensureUnsubscribeToken } from '../utils/unsubscribeTokens'
import { checkAndCompleteCampaign } from '../utils/campaignCompletion'
import {
  EmailQueueRow,
  claimJobs,
  markJobSent,
  rescheduleJob,
  failJobWithRetry,
  enqueueJob,
  resetStuckJobs,
} from '../queues/dbEmailQueue'

const POLL_INTERVAL_MS = 30_000
const BATCH_SIZE = 5
const MAX_ATTEMPTS = 3

async function processEmailJob(job: EmailQueueRow): Promise<void> {
  const campaignId    = job.campaign_id
  const sequenceId    = job.sequence_id
  const stepId        = job.step_id
  const leadId        = job.lead_id
  const mailboxId     = job.mailbox_id
  const sendOnWeekends = job.send_on_weekends

  // Fetch lead — check if still eligible to receive emails
  const { data: lead } = await supabaseAdmin
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()
  if (
    !lead ||
    ['replied', 'opted_out', 'unsubscribed', 'bounced'].includes(
      (lead as { status: string }).status
    )
  ) {
    console.log(
      `[EmailSender] Skipping lead ${leadId} — status: ${(lead as { status: string } | null)?.status}`
    )
    await markJobSent(job.id)
    return
  }

  // Idempotency guard — skip if this exact step was already sent to this lead.
  const { count: alreadySentCount } = await supabaseAdmin
    .from('email_logs')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId)
    .eq('step_id', stepId)
    .eq('status', 'sent')
  if ((alreadySentCount ?? 0) > 0) {
    console.log(`[EmailSender] Step ${stepId} already sent to lead ${leadId} — skipping duplicate job`)
    await markJobSent(job.id)
    return
  }

  // Fetch sequence step
  const { data: step } = await supabaseAdmin
    .from('sequence_steps')
    .select('*, sequences(id)')
    .eq('id', stepId)
    .single()
  if (!step) throw new Error(`Step ${stepId} not found`)

  // Fetch mailbox — check pause status and warmup date
  const { data: mailbox } = await supabaseAdmin
    .from('mailboxes')
    .select('*')
    .eq('id', mailboxId)
    .single()
  if (!mailbox) throw new Error(`Mailbox ${mailboxId} not found`)

  if ((mailbox as { is_paused: boolean }).is_paused) {
    console.warn(`[EmailSender] Mailbox ${mailboxId} is paused — skipping job ${job.id}`)
    await markJobSent(job.id)
    return
  }

  const mailboxTyped = mailbox as {
    warmup_started_at: string
    daily_email_limit: number
    weekly_email_limit: number
    is_paused: boolean
    email: string
  }

  // Runtime daily limit check
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const { count: sentToday } = await supabaseAdmin
    .from('email_logs')
    .select('id', { count: 'exact', head: true })
    .eq('mailbox_id', mailboxId)
    .eq('status', 'sent')
    .gte('sent_at', todayStart.toISOString())

  const dailyLimit = getDailyLimit(
    mailboxTyped.warmup_started_at ? new Date(mailboxTyped.warmup_started_at) : null,
    mailboxTyped.daily_email_limit
  )
  if ((sentToday ?? 0) >= dailyLimit) {
    const delay = msUntilNextDaySendWindow(sendOnWeekends)
    await rescheduleJob(job.id, delay)
    console.log(`[EmailSender] Mailbox ${mailboxId} hit daily limit (${dailyLimit}) — rescheduled for next send window`)
    return
  }

  // Weekly limit check
  const weekStart = new Date()
  weekStart.setUTCHours(0, 0, 0, 0)
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7))
  const { count: sentThisWeek } = await supabaseAdmin
    .from('email_logs')
    .select('id', { count: 'exact', head: true })
    .eq('mailbox_id', mailboxId)
    .eq('status', 'sent')
    .gte('sent_at', weekStart.toISOString())

  if ((sentThisWeek ?? 0) >= mailboxTyped.weekly_email_limit) {
    const nextMonday = new Date(weekStart)
    nextMonday.setUTCDate(nextMonday.getUTCDate() + 7)
    nextMonday.setUTCHours(9, 0, 0, 0)
    const delay = nextMonday.getTime() - Date.now()
    await rescheduleJob(job.id, delay)
    console.log(`[EmailSender] Mailbox ${mailboxId} hit weekly limit (${mailboxTyped.weekly_email_limit}) — rescheduled for next Monday`)
    return
  }

  // Merge template variables
  const subject = mergeVars(
    (step as { subject: string }).subject,
    lead as { first_name: string | null; last_name: string | null; email: string; company_name: string | null; position: string | null }
  )
  const body = mergeVars(
    (step as { body: string }).body,
    lead as { first_name: string | null; last_name: string | null; email: string; company_name: string | null; position: string | null }
  )

  // Convert plain text body to HTML
  const htmlBody = body
    .split(/\n\n+/)
    .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('\n')

  const mailboxEmail = mailboxTyped.email

  const tokenRecord = await ensureUnsubscribeToken(
    leadId,
    (lead as { company_id: string }).company_id
  )

  console.log(`[EmailSender] unsubscribe tokenRecord for lead ${leadId}:`, tokenRecord.token)

  const unsubscribeUrl = `${process.env.FRONTEND_URL}/unsubscribe?token=${tokenRecord.token}`
  const unsubscribeBlock =
    `\n<p style="margin-top:32px;font-size:11px;color:#94a3b8;text-align:center">` +
    `You received this email because you are on our outreach list. ` +
    `<a href="${unsubscribeUrl}" style="color:#94a3b8">Unsubscribe</a></p>`

  const apiUnsubscribeUrl = `${process.env.API_URL}/api/unsubscribe?token=${tokenRecord.token}`
  const emailHtml = htmlBody + unsubscribeBlock

  console.log(
    `[EmailSender pid=${process.pid}] Prepared email HTML for job ${job.id}, lead ${leadId}: ` +
    `containsUnsubscribe=${emailHtml.includes(unsubscribeUrl)} length=${emailHtml.length}`
  )

  if (!emailHtml.includes(unsubscribeUrl)) {
    throw new Error(`Unsubscribe link missing from rendered HTML for lead ${leadId}`)
  }

  const primaryEmail = (lead as { email: string }).email
  const officeEmailRaw = (lead as { office_email?: string | null }).office_email?.trim() || null
  const officeEmail = officeEmailRaw && officeEmailRaw.toLowerCase() !== primaryEmail.trim().toLowerCase()
    ? officeEmailRaw
    : null

  const sendSingleEmail = async (toAddress: string) => {
    await sesClient.send(
      new SendEmailCommand({
        Source: mailboxEmail,
        ReplyToAddresses: [mailboxEmail],
        Destination: { ToAddresses: [toAddress] },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: emailHtml, Charset: 'UTF-8' } },
        },
        ...({
          Headers: [
            { Name: 'List-Unsubscribe', Value: `<${apiUnsubscribeUrl}>` },
            { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
          ],
        } as Record<string, unknown>),
      })
    )
    await supabaseAdmin.from('email_logs').insert({
      campaign_id: campaignId,
      sequence_id: sequenceId,
      step_id: stepId,
      lead_id: leadId,
      mailbox_id: mailboxId,
      status: 'sent',
      sent_subject: subject,
      sent_body: body,
      sent_at: new Date().toISOString(),
      recipient_email: toAddress,
    })
  }

  // Send to primary email
  await sendSingleEmail(primaryEmail)

  // Send a separate email to office_email when it differs from the primary
  if (officeEmail) {
    console.log(`[EmailSender] Job ${job.id} — also sending to office email ${officeEmail}`)
    await sendSingleEmail(officeEmail)
  }

  await markJobSent(job.id)

  // Schedule the next sequence step if one exists
  const { data: nextStep } = await supabaseAdmin
    .from('sequence_steps')
    .select('id, delay_days, step_order')
    .eq('sequence_id', sequenceId)
    .gt('step_order', (step as { step_order: number }).step_order)
    .order('step_order')
    .limit(1)
    .maybeSingle()

  if (nextStep) {
    const delayMs = delayMsForNextStep(
      (nextStep as { delay_days: number }).delay_days || 1,
      sendOnWeekends
    )
    await enqueueJob(
      `send-${leadId}-${sequenceId}-next`,
      {
        campaignId,
        sequenceId,
        stepId: (nextStep as { id: string }).id,
        leadId,
        mailboxId,
        sendOnWeekends,
      },
      delayMs
    )
  }

  await checkAndCompleteCampaign(campaignId)
}

async function processEmailQueue(): Promise<void> {
  try {
    await resetStuckJobs()
  } catch (err) {
    console.error('[EmailSender] resetStuckJobs error:', err)
  }

  let jobs: EmailQueueRow[]
  try {
    jobs = await claimJobs(BATCH_SIZE)
  } catch (err) {
    console.error('[EmailSender] claimJobs error:', err)
    return
  }

  if (jobs.length === 0) return

  await Promise.allSettled(
    jobs.map(async (job) => {
      try {
        await processEmailJob(job)
        console.log(`[EmailSender] Job ${job.id} completed`)
      } catch (err) {
        const error = err as Error
        console.error(`[EmailSender] Job ${job.id} failed (attempt ${job.attempts + 1}/${MAX_ATTEMPTS}):`, error.message)
        await failJobWithRetry(job, error, MAX_ATTEMPTS)
        // Write to email_logs only when all retries are exhausted
        if (job.attempts + 1 >= MAX_ATTEMPTS) {
          await supabaseAdmin
            .from('email_logs')
            .insert({
              campaign_id: job.campaign_id,
              sequence_id: job.sequence_id,
              step_id: job.step_id,
              lead_id: job.lead_id,
              mailbox_id: job.mailbox_id,
              status: 'failed',
              sent_at: new Date().toISOString(),
              error_message: error.message,
            })
            .then(() => {}, () => {})
        }
      }
    })
  )
}

export function startEmailSender(): ReturnType<typeof setInterval> {
  console.log(`[EmailSender] Starting DB-backed email queue poller (interval=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE})`)
  void processEmailQueue()
  return setInterval(() => void processEmailQueue(), POLL_INTERVAL_MS)
}
