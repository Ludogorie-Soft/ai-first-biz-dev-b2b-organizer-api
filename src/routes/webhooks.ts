/**
 * POST /webhooks/ses
 *
 * Receives AWS SES bounce/complaint notifications delivered via Amazon SNS.
 *
 * Setup in AWS:
 *   1. SNS → Create topic → note the ARN
 *   2. SES → Configuration Sets (or Identity) → Notifications → set the SNS topic for Bounces + Complaints
 *   3. SNS → Subscriptions → subscribe this endpoint URL (https://your-api/webhooks/ses?token=SECRET)
 *   4. The first SNS call will be a SubscriptionConfirmation — this handler auto-confirms it.
 *
 * Security: requests must include ?token=SES_WEBHOOK_SECRET in the URL.
 */

import { Router, Request, Response } from 'express'
import https from 'https'
import { supabaseAdmin } from '../config/supabase'
import { HARD_BOUNCE_THRESHOLD } from '../utils/warmup'

const router = Router()

// ── Types ──────────────────────────────────────────────────────────────────

interface SnsEnvelope {
  Type: 'SubscriptionConfirmation' | 'Notification' | 'UnsubscribeConfirmation'
  SubscribeURL?: string
  Message: string
}

interface SesBouncedRecipient {
  emailAddress: string
  action?: string
  diagnosticCode?: string
}

interface SesBounceNotification {
  notificationType: 'Bounce'
  bounce: {
    bounceType: 'Permanent' | 'Transient' | 'Undetermined'
    bounceSubType: string
    bouncedRecipients: SesBouncedRecipient[]
    feedbackId: string
  }
  mail: { destination: string[] }
}

interface SesComplaintNotification {
  notificationType: 'Complaint'
  complaint: {
    complainedRecipients: Array<{ emailAddress: string }>
    complaintFeedbackType?: string
  }
  mail: { destination: string[] }
}

// ── Helper: check if bounce rate exceeds threshold and pause mailbox ───────

async function checkAndPauseIfNeeded(mailboxId: string): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: logs } = await supabaseAdmin
    .from('email_logs')
    .select('status')
    .eq('mailbox_id', mailboxId)
    .in('status', ['sent', 'bounced'])
    .gte('created_at', thirtyDaysAgo)

  if (!logs || logs.length < 10) return  // not enough data yet

  const total   = logs.length
  const bounced = logs.filter((l: { status: string }) => l.status === 'bounced').length
  const rate    = bounced / total

  if (rate > HARD_BOUNCE_THRESHOLD) {
    await supabaseAdmin
      .from('mailboxes')
      .update({ is_paused: true })
      .eq('id', mailboxId)

    console.warn(
      `[Webhook] Mailbox ${mailboxId} paused — hard bounce rate ${(rate * 100).toFixed(1)}% exceeds ${HARD_BOUNCE_THRESHOLD * 100}% threshold`
    )
  }
}

// ── Route ──────────────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response): Promise<void> => {
  // Token guard — must match SES_WEBHOOK_SECRET
  const secret = process.env.SES_WEBHOOK_SECRET
  if (secret && req.query.token !== secret) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  // SNS sends content-type: text/plain; the body is a JSON string
  let envelope: SnsEnvelope
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    envelope = JSON.parse(raw) as SnsEnvelope
  } catch {
    res.status(400).json({ error: 'Invalid JSON' })
    return
  }

  // Auto-confirm SNS subscription
  if (envelope.Type === 'SubscriptionConfirmation' && envelope.SubscribeURL) {
    console.log('[Webhook] Confirming SNS subscription...')
    https.get(envelope.SubscribeURL, (r) => {
      console.log(`[Webhook] SNS subscription confirmed — status ${r.statusCode}`)
    }).on('error', (e) => console.error('[Webhook] SNS confirmation error:', e.message))
    res.status(200).send('OK')
    return
  }

  if (envelope.Type !== 'Notification') {
    res.status(200).send('OK')
    return
  }

  let notification: SesBounceNotification | SesComplaintNotification
  try {
    notification = JSON.parse(envelope.Message) as SesBounceNotification | SesComplaintNotification
  } catch {
    res.status(400).json({ error: 'Invalid SES message' })
    return
  }

  // ── Handle hard bounces ──────────────────────────────────────────────────
  if (
    notification.notificationType === 'Bounce' &&
    (notification as SesBounceNotification).bounce.bounceType === 'Permanent'
  ) {
    const bounce = (notification as SesBounceNotification).bounce

    for (const recipient of bounce.bouncedRecipients) {
      const email = recipient.emailAddress.toLowerCase()

      // Mark lead as bounced (match both personal and office email fields)
      const { data: leads } = await supabaseAdmin
        .from('leads')
        .update({ status: 'bounced' })
        .or(`email.eq.${email},office_email.eq.${email}`)
        .select('id, company_id')

      // Update the most recent email_log for this lead to bounced
      if (leads && leads.length > 0) {
        for (const lead of leads as Array<{ id: string; company_id: string }>) {
          const { data: log } = await supabaseAdmin
            .from('email_logs')
            .select('id, mailbox_id')
            .eq('lead_id', lead.id)
            .eq('status', 'sent')
            .order('created_at', { ascending: false })
            .limit(1)
            .single()

          if (log) {
            await supabaseAdmin
              .from('email_logs')
              .update({ status: 'bounced' })
              .eq('id', (log as { id: string }).id)

            await checkAndPauseIfNeeded((log as { id: string; mailbox_id: string }).mailbox_id)
          }
        }
      }

      console.log(`[Webhook] Hard bounce: ${email}`)
    }
  }

  // ── Handle complaints (mark as opted_out) ────────────────────────────────
  if (notification.notificationType === 'Complaint') {
    const complaint = (notification as SesComplaintNotification).complaint

    for (const recipient of complaint.complainedRecipients) {
      const email = recipient.emailAddress.toLowerCase()

      await supabaseAdmin
        .from('leads')
        .update({ status: 'opted_out' })
        .or(`email.eq.${email},office_email.eq.${email}`)

      console.log(`[Webhook] Complaint (opted out): ${email}`)
    }
  }

  res.status(200).send('OK')
})

export default router
