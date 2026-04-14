import { Worker, Job } from 'bullmq'
import { SendEmailCommand } from '@aws-sdk/client-ses'
import { redis } from '../config/redis'
import { sesClient } from '../config/ses'
import { supabaseAdmin } from '../config/supabase'
import { decrypt } from '../utils/encrypt'
import { mergeVars } from '../utils/mergeVars'
import { emailQueue } from '../queues/emailQueue'
import { EmailJobData } from '../types'
import { getDailyLimit, delayMsForNextStep } from '../utils/warmup'
import { ensureUnsubscribeToken } from '../utils/unsubscribeTokens'

function createEmailSenderWorker(): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>(
    'email-sending',
    async (job: Job<EmailJobData>): Promise<void> => {
      const { campaignId, sequenceId, stepId, leadId, mailboxId } = job.data

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
          `[Worker] Skipping lead ${leadId} — status: ${(lead as { status: string } | null)?.status}`
        )
        return
      }

      // Fetch sequence step
      const { data: step } = await supabaseAdmin
        .from('sequence_steps')
        .select('*, sequences(id)')
        .eq('id', stepId)
        .single()
      if (!step) throw new Error(`Step ${stepId} not found`)

      // Fetch mailbox — also check pause status and warmup date
      const { data: mailbox } = await supabaseAdmin
        .from('mailboxes')
        .select('*')
        .eq('id', mailboxId)
        .single()
      if (!mailbox) throw new Error(`Mailbox ${mailboxId} not found`)

      // Skip if mailbox was paused (e.g. by bounce rate threshold)
      if ((mailbox as { is_paused: boolean }).is_paused) {
        console.warn(`[Worker] Mailbox ${mailboxId} is paused — skipping job ${job.id}`)
        return
      }

      // Runtime daily limit check — safety net in case scheduler miscounted
      const todayStart = new Date()
      todayStart.setUTCHours(0, 0, 0, 0)
      const { count: sentToday } = await supabaseAdmin
        .from('email_logs')
        .select('id', { count: 'exact', head: true })
        .eq('mailbox_id', mailboxId)
        .eq('status', 'sent')
        .gte('sent_at', todayStart.toISOString())

      const dailyLimit = getDailyLimit(
        (mailbox as { warmup_started_at: string }).warmup_started_at
          ? new Date((mailbox as { warmup_started_at: string }).warmup_started_at)
          : null
      )
      if ((sentToday ?? 0) >= dailyLimit) {
        // Requeue for tomorrow at working hours start
        const tomorrow = new Date()
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
        tomorrow.setUTCHours(9, 0, 0, 0)
        const delay = tomorrow.getTime() - Date.now()
        await emailQueue.add(job.name, job.data, { delay })
        console.log(`[Worker] Mailbox ${mailboxId} hit daily limit (${dailyLimit}) — requeued for tomorrow`)
        return
      }

      // Merge template variables into subject and body
      const subject = mergeVars(
        (step as { subject: string }).subject,
        lead as { first_name: string | null; last_name: string | null; email: string; company_name: string | null; position: string | null }
      )
      const body = mergeVars(
        (step as { body: string }).body,
        lead as { first_name: string | null; last_name: string | null; email: string; company_name: string | null; position: string | null }
      )

      // Convert plain text body to HTML — preserve paragraph and line breaks
      const htmlBody = body
        .split(/\n\n+/)
        .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
        .join('\n')

      const mailboxEmail = (mailbox as { email: string }).email

      const tokenRecord = await ensureUnsubscribeToken(
        leadId,
        (lead as { company_id: string }).company_id
      )

      console.log(`[Worker] unsubscribe tokenRecord for lead ${leadId}:`, tokenRecord.token)

      const unsubscribeUrl = `${process.env.FRONTEND_URL}/unsubscribe?token=${tokenRecord.token}`

      const unsubscribeBlock =
        `\n<p style="margin-top:32px;font-size:11px;color:#94a3b8;text-align:center">` +
        `You received this email because you are on our outreach list. ` +
        `<a href="${unsubscribeUrl}" style="color:#94a3b8">Unsubscribe</a></p>`

      // RFC 8058 one-click unsubscribe headers (required by Google/Yahoo for bulk senders)
      const apiUnsubscribeUrl = `${process.env.API_URL}/api/unsubscribe?token=${tokenRecord.token}`
      const emailHtml = htmlBody + unsubscribeBlock

      console.log(
        `[Worker pid=${process.pid}] Prepared email HTML for job ${job.id}, lead ${leadId}: ` +
        `containsUnsubscribe=${emailHtml.includes(unsubscribeUrl)} length=${emailHtml.length}`
      )

      if (!emailHtml.includes(unsubscribeUrl)) {
        throw new Error(`Unsubscribe link missing from rendered HTML for lead ${leadId}`)
      }

      // Send via AWS SES — always from the mailbox email (must be SES-verified)
      await sesClient.send(
        new SendEmailCommand({
          Source: mailboxEmail,
          ReplyToAddresses: [mailboxEmail],
          Destination: { ToAddresses: [(lead as { email: string }).email] },
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

      // Log successful send
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
      })

      // Fetch and schedule the next step in the sequence (if any)
      const { data: nextStep } = await supabaseAdmin
        .from('sequence_steps')
        .select('id, delay_days, step_order')
        .eq('sequence_id', sequenceId)
        .gt('step_order', (step as { step_order: number }).step_order)
        .order('step_order')
        .limit(1)
        .single()

      if (nextStep) {
        const delayMs = delayMsForNextStep(
          (nextStep as { delay_days: number }).delay_days || 1
        )
        await emailQueue.add(
          `send-${leadId}-${sequenceId}-next`,
          {
            campaignId,
            sequenceId,
            stepId: (nextStep as { id: string }).id,
            leadId,
            mailboxId,
          },
          { delay: delayMs }
        )
      }
    },
    {
      connection: redis,
      concurrency: 5,
    }
  )

  worker.on('failed', async (job: Job<EmailJobData> | undefined, err: Error) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message)
    if (job?.data) {
      const { campaignId, sequenceId, stepId, leadId, mailboxId } = job.data
      await supabaseAdmin
        .from('email_logs')
        .insert({
          campaign_id: campaignId,
          sequence_id: sequenceId,
          step_id: stepId,
          lead_id: leadId,
          mailbox_id: mailboxId,
          status: 'failed',
        })
        .then(() => {}, () => {})
    }
  })

  worker.on('completed', (job: Job<EmailJobData>) =>
    console.log(`[Worker] Job ${job.id} completed`)
  )

  return worker
}

export { createEmailSenderWorker }
