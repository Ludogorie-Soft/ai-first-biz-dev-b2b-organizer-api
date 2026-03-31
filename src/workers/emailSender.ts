import { Worker, Job } from 'bullmq'
import { SendEmailCommand } from '@aws-sdk/client-ses'
import { redis } from '../config/redis'
import { sesClient } from '../config/ses'
import { supabaseAdmin } from '../config/supabase'
import { decrypt } from '../utils/encrypt'
import { mergeVars } from '../utils/mergeVars'
import { emailQueue } from '../queues/emailQueue'
import { EmailJobData } from '../types'

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

      // Fetch mailbox
      const { data: mailbox } = await supabaseAdmin
        .from('mailboxes')
        .select('*')
        .eq('id', mailboxId)
        .single()
      if (!mailbox) throw new Error(`Mailbox ${mailboxId} not found`)

      // Merge template variables into subject and body
      const subject = mergeVars(
        (step as { subject: string }).subject,
        lead as { first_name: string | null; last_name: string | null; email: string }
      )
      const body = mergeVars(
        (step as { body: string }).body,
        lead as { first_name: string | null; last_name: string | null; email: string }
      )

      // Use SES_FROM_EMAIL env var if set, otherwise fall back to mailbox email
      const fromEmail = process.env.SES_FROM_EMAIL || (mailbox as { email: string }).email

      // Send via AWS SES
      await sesClient.send(
        new SendEmailCommand({
          Source: fromEmail,
          Destination: { ToAddresses: [(lead as { email: string }).email] },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Html: { Data: body, Charset: 'UTF-8' } },
          },
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
        const delayMs =
          ((nextStep as { delay_days: number }).delay_days || 1) * 24 * 60 * 60 * 1000
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
