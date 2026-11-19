import { ImapFlow } from 'imapflow'
import { simpleParser, ParsedMail } from 'mailparser'
import { supabaseAdmin } from '../config/supabase'
import { decrypt } from '../utils/encrypt'
import { categorizeReply } from '../utils/categorizeReply'
import { checkAndCompleteCampaign } from '../utils/campaignCompletion'
import { detectBounce, BounceInfo } from '../utils/detectBounce'
import { recordHardBounce } from '../utils/hardBounce'
import { deletePendingJobsForLeads } from '../queues/dbEmailQueue'
import { Mailbox, EncryptedPayload } from '../types'

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Handles a bounce found in the inbox ("address not found" from the recipient's
 * mail server). Permanent bounces mark the address invalid so the rest of the
 * sequence is not sent to it; temporary ones (mailbox full, delayed) are ignored.
 * Safe to run on the same message again: recordHardBounce is idempotent.
 */
async function handleInboxBounce(bounce: BounceInfo, mailbox: Mailbox, subject: string): Promise<void> {
  if (!bounce.permanent) {
    console.log(`[ReplyCatcher] Temporary bounce ignored in mailbox ${mailbox.id}: "${subject}"`)
    return
  }

  const ownAddress = mailbox.email.toLowerCase()
  let addresses = bounce.recipients.filter((a) => a !== ownAddress)

  // Plain-text bounce without machine-readable recipients: keep only addresses
  // that belong to this company's leads.
  if (addresses.length === 0 && bounce.mentionedAddresses.length > 0) {
    const candidates = bounce.mentionedAddresses.filter((a) => a !== ownAddress)
    if (candidates.length > 0) {
      const [{ data: byEmail }, { data: byOffice }] = await Promise.all([
        supabaseAdmin.from('leads').select('email').eq('company_id', mailbox.company_id).in('email', candidates),
        supabaseAdmin
          .from('leads')
          .select('office_email')
          .eq('company_id', mailbox.company_id)
          .in('office_email', candidates),
      ])
      addresses = [
        ...new Set([
          ...((byEmail ?? []) as { email: string }[]).map((l) => l.email),
          ...((byOffice ?? []) as { office_email: string }[]).map((l) => l.office_email),
        ]),
      ]
    }
  }

  if (addresses.length === 0) {
    console.log(`[ReplyCatcher] Bounce in mailbox ${mailbox.id} matches no lead: "${subject}"`)
    return
  }

  const campaignIds = new Set<string>()
  for (const address of addresses) {
    const result = await recordHardBounce(address, { companyId: mailbox.company_id })
    result.campaignIds.forEach((id) => campaignIds.add(id))
    if (result.bouncedLeadIds.length > 0 || result.clearedOfficeLeadIds.length > 0) {
      console.log(
        `[ReplyCatcher] Hard bounce: ${address} — ${result.bouncedLeadIds.length} lead(s) bounced, ` +
          `${result.clearedOfficeLeadIds.length} office email(s) cleared`
      )
    }
  }
  for (const cid of campaignIds) await checkAndCompleteCampaign(cid)
}

async function processMailbox(mailbox: Mailbox): Promise<void> {
  if (!mailbox.imap_config) return

  let config: ReturnType<typeof decrypt>
  try {
    config = decrypt(mailbox.imap_config as EncryptedPayload)
  } catch (e) {
    console.error(
      `[ReplyCatcher] Failed to decrypt config for mailbox ${mailbox.id}:`,
      (e as Error).message
    )
    return
  }

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls !== false,
    auth: { user: config.user, pass: config.password },
    logger: false,
  })

  try {
    await client.connect()
    await client.mailboxOpen('INBOX')

    // Fetch emails received in the last 24 hours that are unseen
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const messages = client.fetch({ since }, { source: true, envelope: true })

    for await (const msg of messages) {
      try {
        if (!msg.source) continue
        const parsed: ParsedMail = await simpleParser(msg.source)

        const bounce = detectBounce(parsed)
        if (bounce) {
          await handleInboxBounce(bounce, mailbox, parsed.subject ?? '')
          continue
        }

        const senderEmail = parsed.from?.value?.[0]?.address?.toLowerCase()
        if (!senderEmail) continue

        // Skip emails sent from the mailbox itself
        if (senderEmail === mailbox.email.toLowerCase()) continue

        // Find leads in this company matching the sender email
        const { data: matchingLeads } = await supabaseAdmin
          .from('leads')
          .select('id')
          .eq('email', senderEmail)
          .eq('company_id', mailbox.company_id)

        if (!matchingLeads || matchingLeads.length === 0) continue

        const leadIds = (matchingLeads as { id: string }[]).map((l) => l.id)

        // Find sent email logs for these leads via this mailbox that haven't been categorized yet
        const { data: logs } = await supabaseAdmin
          .from('email_logs')
          .select('id, campaign_id, lead_id, reply_category')
          .eq('mailbox_id', mailbox.id)
          .eq('status', 'sent')
          .is('reply_category', null)
          .in('lead_id', leadIds)

        if (!logs || logs.length === 0) continue

        const campaignIdsTouched = new Set<string>()

        const replyText: string =
          typeof parsed.text === 'string' && parsed.text.trim()
            ? parsed.text.trim()
            : typeof parsed.html === 'string'
            ? parsed.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
            : ''
        const category = categorizeReply(replyText)

        for (const log of logs as { id: string; lead_id: string; campaign_id: string }[]) {
          // Update email_log with reply category
          await supabaseAdmin
            .from('email_logs')
            .update({ reply_category: category })
            .eq('id', log.id)

          // Update lead status to replied
          await supabaseAdmin
            .from('leads')
            .update({ status: 'replied' })
            .eq('id', log.lead_id)
          await deletePendingJobsForLeads([log.lead_id])

          campaignIdsTouched.add(log.campaign_id)
        }

        for (const cid of campaignIdsTouched) {
          await checkAndCompleteCampaign(cid)
        }

        console.log(`[ReplyCatcher] Reply from ${senderEmail} categorized as: ${category}`)
      } catch (msgErr) {
        console.error('[ReplyCatcher] Error processing message:', (msgErr as Error).message)
      }
    }

    await client.logout()
  } catch (err) {
    console.error(
      `[ReplyCatcher] IMAP error for mailbox ${mailbox.id}:`,
      (err as Error).message
    )
    try {
      await client.logout()
    } catch (_) {}
  }
}

async function runReplyCatcher(): Promise<void> {
  console.log('[ReplyCatcher] Running...')
  try {
    const { data: mailboxes, error } = await supabaseAdmin
      .from('mailboxes')
      .select('id, company_id, email, imap_config')
      .not('imap_config', 'is', null)
    if (error) {
      console.error('[ReplyCatcher] DB error:', error.message)
      return
    }
    if (!mailboxes?.length) return

    await Promise.allSettled((mailboxes as Mailbox[]).map(processMailbox))
  } catch (err) {
    console.error('[ReplyCatcher] Unexpected error:', (err as Error).message)
  }
}

function startReplyCatcher(): ReturnType<typeof setInterval> {
  void runReplyCatcher()
  return setInterval(() => void runReplyCatcher(), POLL_INTERVAL_MS)
}

export { startReplyCatcher }
