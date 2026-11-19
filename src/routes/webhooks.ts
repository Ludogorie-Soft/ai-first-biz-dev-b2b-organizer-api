/**
 * POST /webhooks/ses
 *
 * Receives AWS SES bounce/complaint notifications delivered via Amazon SNS.
 *
 * Setup in AWS: see "SES Webhook Setup (AWS)" in README.md. In short:
 *   1. SNS → Create topic, type Standard (SES rejects FIFO topics)
 *   2. SNS → Subscriptions → HTTPS → https://your-api/webhooks/ses?token=SECRET (raw delivery off)
 *   3. The first SNS call is a SubscriptionConfirmation — this handler auto-confirms it
 *   4. SES → Identity → Notifications → set the SNS topic for Bounces + Complaints
 *
 * Security: requests must include ?token=SES_WEBHOOK_SECRET in the URL.
 */

import { Router, Request, Response } from 'express'
import https from 'https'
import { supabaseAdmin } from '../config/supabase'
import { recordHardBounce } from '../utils/hardBounce'
import { deletePendingJobsForLeads } from '../queues/dbEmailQueue'

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

  // Auto-confirm SNS subscription. Awaited before responding: on serverless
  // (Vercel) the function is frozen once the response is sent, so a
  // fire-and-forget request would never reach AWS.
  if (envelope.Type === 'SubscriptionConfirmation' && envelope.SubscribeURL) {
    const subscribeUrl = envelope.SubscribeURL
    let host: string
    try {
      host = new URL(subscribeUrl).hostname
    } catch {
      res.status(400).json({ error: 'Invalid SubscribeURL' })
      return
    }
    // Only follow confirmation links that point at AWS SNS
    if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) {
      console.warn(`[Webhook] Rejected SubscribeURL with unexpected host: ${host}`)
      res.status(400).json({ error: 'Invalid SubscribeURL' })
      return
    }

    console.log('[Webhook] Confirming SNS subscription...')
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        https
          .get(subscribeUrl, (r) => {
            r.resume() // drain the body so the request completes
            r.on('end', () => resolve(r.statusCode))
          })
          .on('error', reject)
      })
      console.log(`[Webhook] SNS subscription confirmed — status ${status}`)
      res.status(200).send('OK')
    } catch (e) {
      console.error('[Webhook] SNS confirmation error:', (e as Error).message)
      res.status(500).json({ error: 'Subscription confirmation failed' })
    }
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
      try {
        const result = await recordHardBounce(email)
        console.log(
          `[Webhook] Hard bounce: ${email} — ${result.bouncedLeadIds.length} lead(s) bounced, ` +
          `${result.clearedOfficeLeadIds.length} office email(s) cleared`
        )
      } catch (err) {
        console.error(`[Webhook] Failed to record hard bounce for ${email}:`, (err as Error).message)
      }
    }
  }

  // ── Handle complaints (mark as opted_out) ────────────────────────────────
  if (notification.notificationType === 'Complaint') {
    const complaint = (notification as SesComplaintNotification).complaint

    for (const recipient of complaint.complainedRecipients) {
      const email = recipient.emailAddress.toLowerCase()

      const { data: optedOut } = await supabaseAdmin
        .from('leads')
        .update({ status: 'opted_out' })
        .or(`email.eq.${email},office_email.eq.${email}`)
        .select('id')
      await deletePendingJobsForLeads(((optedOut ?? []) as { id: string }[]).map((l) => l.id))

      console.log(`[Webhook] Complaint (opted out): ${email}`)
    }
  }

  res.status(200).send('OK')
})

export default router
