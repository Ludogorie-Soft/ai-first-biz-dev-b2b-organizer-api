import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'
import { sesClient } from '../config/ses'
import { GetIdentityVerificationAttributesCommand } from '@aws-sdk/client-ses'
import { enqueueCampaignJobs } from '../utils/enqueueCampaignJobs'

function getMondayUtcMidnight(): Date {
  const monday = new Date()
  monday.setUTCHours(0, 0, 0, 0)
  const daysFromMonday = (monday.getUTCDay() + 6) % 7
  monday.setUTCDate(monday.getUTCDate() - daysFromMonday)
  return monday
}

const router = Router()
router.use(authMiddleware)

// Only global_admin users may access these endpoints
function globalAdminOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.user.role !== 'global_admin') {
    res.status(403).json({ error: 'Global admin access required' })
    return
  }
  next()
}
router.use(globalAdminOnly)

/**
 * @swagger
 * /admin/mailboxes:
 *   get:
 *     summary: List all pending mailboxes across all companies (global admin only)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of pending mailboxes with company info and pending campaign count
 */
router.get('/mailboxes', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('mailboxes')
      .select(`
        id, email, ses_status, is_paused, created_at,
        company:companies(id, name),
        campaign_mailboxes(campaign:campaigns(id, status))
      `)
      .eq('ses_status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      res.status(400).json({ error: error.message })
      return
    }

    const result = (data ?? []).map((mb: any) => {
      const pendingCampaigns = (mb.campaign_mailboxes ?? []).filter(
        (cm: any) => cm.campaign?.status === 'pending_mailbox_approval'
      )
      return {
        id: mb.id,
        email: mb.email,
        ses_status: mb.ses_status,
        created_at: mb.created_at,
        company_id: mb.company?.id,
        company_name: mb.company?.name,
        pending_campaign_count: pendingCampaigns.length,
      }
    })

    res.json(result)
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /admin/mailboxes/{id}/approve:
 *   patch:
 *     summary: Approve a mailbox (mark as active in SES) — global admin only
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Mailbox approved, waiting campaigns activated where possible
 *       404:
 *         description: Mailbox not found
 */
router.patch('/mailboxes/:id/approve', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid mailbox ID' })
    return
  }

  try {
    // 1. Fetch the mailbox to get the email address
    const { data: mailbox, error: mbErr } = await supabaseAdmin
      .from('mailboxes')
      .select('id, email, company_id')
      .eq('id', req.params.id)
      .single()

    if (mbErr || !mailbox) {
      res.status(404).json({ error: 'Mailbox not found' })
      return
    }

    // 2. Check that the identity is actually verified in SES before approving
    const verificationResult = await sesClient.send(
      new GetIdentityVerificationAttributesCommand({ Identities: [mailbox.email] })
    )
    const attr = verificationResult.VerificationAttributes?.[mailbox.email]
    if (!attr || attr.VerificationStatus !== 'Success') {
      res.status(400).json({
        error: 'ses_not_verified',
        ses_verification_status: attr?.VerificationStatus ?? 'NotStarted',
      })
      return
    }

    // 3. Mark the mailbox as active in our database
    await supabaseAdmin
      .from('mailboxes')
      .update({ ses_status: 'active' })
      .eq('id', req.params.id)

    // 4. Find all pending_mailbox_approval campaigns that use this mailbox
    const { data: linkedCampaigns } = await supabaseAdmin
      .from('campaign_mailboxes')
      .select('campaign_id')
      .eq('mailbox_id', req.params.id)

    if (!linkedCampaigns || linkedCampaigns.length === 0) {
      res.json({ mailbox, activated_campaigns: 0 })
      return
    }

    const campaignIds = linkedCampaigns.map((r: { campaign_id: string }) => r.campaign_id)

    // 5. Filter to only those with status pending_mailbox_approval
    const { data: pendingCampaigns } = await supabaseAdmin
      .from('campaigns')
      .select('id')
      .in('id', campaignIds)
      .eq('status', 'pending_mailbox_approval')

    if (!pendingCampaigns || pendingCampaigns.length === 0) {
      res.json({ mailbox, activated_campaigns: 0 })
      return
    }

    // 6. For each pending campaign, check if ALL its mailboxes are now active
    const campaignsToActivate: string[] = []

    for (const camp of pendingCampaigns) {
      const { data: campMailboxes } = await supabaseAdmin
        .from('campaign_mailboxes')
        .select('mailbox_id, mailbox:mailboxes(ses_status)')
        .eq('campaign_id', camp.id)

      const allActive = (campMailboxes ?? []).every(
        (cm: any) => cm.mailbox?.ses_status === 'active'
      )
      if (allActive) {
        campaignsToActivate.push(camp.id)
      }
    }

    // 7. Activate the qualifying campaigns and enqueue jobs for existing leads
    if (campaignsToActivate.length > 0) {
      await supabaseAdmin
        .from('campaigns')
        .update({ status: 'active' })
        .in('id', campaignsToActivate)

      // Enqueue step-1 jobs for leads already imported while the campaign was pending
      for (const campId of campaignsToActivate) {
        const { data: existingLeads } = await supabaseAdmin
          .from('leads')
          .select('id')
          .eq('campaign_id', campId)
          .eq('status', 'active')

        if (existingLeads && existingLeads.length > 0) {
          const leadIds = existingLeads.map((l: { id: string }) => l.id)
          await enqueueCampaignJobs(campId, leadIds).catch((e: Error) =>
            console.error(`[Admin] Failed to enqueue jobs for campaign ${campId}:`, e.message)
          )
        }
      }
    }

    res.json({ mailbox, activated_campaigns: campaignsToActivate.length })
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /admin/mailboxes/{id}/approve-domain:
 *   patch:
 *     summary: Approve a mailbox by skipping the SES email check (domain is approved in SES) — global admin only
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Mailbox approved, waiting campaigns activated where possible
 *       404:
 *         description: Mailbox not found
 */
router.patch('/mailboxes/:id/approve-domain', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid mailbox ID' })
    return
  }

  try {
    // 1. Fetch the mailbox
    const { data: mailbox, error: mbErr } = await supabaseAdmin
      .from('mailboxes')
      .select('id, email, company_id')
      .eq('id', req.params.id)
      .single()

    if (mbErr || !mailbox) {
      res.status(404).json({ error: 'Mailbox not found' })
      return
    }

    // 2. Mark the mailbox as active — SES check skipped (domain is approved)
    await supabaseAdmin
      .from('mailboxes')
      .update({ ses_status: 'active' })
      .eq('id', req.params.id)

    // 3. Find all pending_mailbox_approval campaigns that use this mailbox
    const { data: linkedCampaigns } = await supabaseAdmin
      .from('campaign_mailboxes')
      .select('campaign_id')
      .eq('mailbox_id', req.params.id)

    if (!linkedCampaigns || linkedCampaigns.length === 0) {
      res.json({ mailbox, activated_campaigns: 0 })
      return
    }

    const campaignIds = linkedCampaigns.map((r: { campaign_id: string }) => r.campaign_id)

    // 4. Filter to only those with status pending_mailbox_approval
    const { data: pendingCampaigns } = await supabaseAdmin
      .from('campaigns')
      .select('id')
      .in('id', campaignIds)
      .eq('status', 'pending_mailbox_approval')

    if (!pendingCampaigns || pendingCampaigns.length === 0) {
      res.json({ mailbox, activated_campaigns: 0 })
      return
    }

    // 5. For each pending campaign, check if ALL its mailboxes are now active
    const campaignsToActivate: string[] = []

    for (const camp of pendingCampaigns) {
      const { data: campMailboxes } = await supabaseAdmin
        .from('campaign_mailboxes')
        .select('mailbox_id, mailbox:mailboxes(ses_status)')
        .eq('campaign_id', camp.id)

      const allActive = (campMailboxes ?? []).every(
        (cm: any) => cm.mailbox?.ses_status === 'active'
      )
      if (allActive) {
        campaignsToActivate.push(camp.id)
      }
    }

    // 6. Activate the qualifying campaigns and enqueue jobs for existing leads
    if (campaignsToActivate.length > 0) {
      await supabaseAdmin
        .from('campaigns')
        .update({ status: 'active' })
        .in('id', campaignsToActivate)

      for (const campId of campaignsToActivate) {
        const { data: existingLeads } = await supabaseAdmin
          .from('leads')
          .select('id')
          .eq('campaign_id', campId)
          .eq('status', 'active')

        if (existingLeads && existingLeads.length > 0) {
          const leadIds = existingLeads.map((l: { id: string }) => l.id)
          await enqueueCampaignJobs(campId, leadIds).catch((e: Error) =>
            console.error(`[Admin] Failed to enqueue jobs for campaign ${campId}:`, e.message)
          )
        }
      }
    }

    res.json({ mailbox, activated_campaigns: campaignsToActivate.length })
  } catch (err) {
    next(err)
  }
})

const mailboxLimitsSchema = z
  .object({
    daily_email_limit: z.number().int().positive(),
    weekly_email_limit: z.number().int().positive(),
  })
  .refine((d) => d.weekly_email_limit >= d.daily_email_limit, {
    message: 'Weekly limit must be greater than or equal to daily limit',
    path: ['weekly_email_limit'],
  })

/**
 * @swagger
 * /admin/mailboxes/limits:
 *   get:
 *     summary: List all mailboxes with their email limits and current usage (global admin only)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of mailboxes with limit config and usage stats
 */
router.get('/mailboxes/limits', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('mailboxes')
      .select('id, email, daily_email_limit, weekly_email_limit, company:companies(id, name)')
      .order('created_at', { ascending: false })

    if (error) {
      res.status(400).json({ error: error.message })
      return
    }

    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const weekStart = getMondayUtcMidnight()

    const result = await Promise.all(
      (data ?? []).map(async (mb: any) => {
        const [{ count: sentToday }, { count: sentThisWeek }] = await Promise.all([
          supabaseAdmin
            .from('email_logs')
            .select('id', { count: 'exact', head: true })
            .eq('mailbox_id', mb.id)
            .eq('status', 'sent')
            .gte('sent_at', todayStart.toISOString()),
          supabaseAdmin
            .from('email_logs')
            .select('id', { count: 'exact', head: true })
            .eq('mailbox_id', mb.id)
            .eq('status', 'sent')
            .gte('sent_at', weekStart.toISOString()),
        ])

        return {
          id: mb.id,
          email: mb.email,
          company_id: (mb.company as { id: string } | null)?.id,
          company_name: (mb.company as { name: string } | null)?.name,
          daily_email_limit: mb.daily_email_limit,
          weekly_email_limit: mb.weekly_email_limit,
          sent_today: sentToday ?? 0,
          sent_this_week: sentThisWeek ?? 0,
        }
      })
    )

    res.json(result)
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /admin/mailboxes/{id}/limits:
 *   patch:
 *     summary: Update email send limits for a mailbox (global admin only)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [daily_email_limit, weekly_email_limit]
 *             properties:
 *               daily_email_limit: { type: integer, minimum: 1 }
 *               weekly_email_limit: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: Updated mailbox limits
 *       400:
 *         description: Validation error
 *       404:
 *         description: Mailbox not found
 */
router.patch('/mailboxes/:id/limits', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid mailbox ID' })
    return
  }

  const parsed = mailboxLimitsSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors })
    return
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('mailboxes')
      .update({
        daily_email_limit: parsed.data.daily_email_limit,
        weekly_email_limit: parsed.data.weekly_email_limit,
      })
      .eq('id', req.params.id)
      .select('id, email, daily_email_limit, weekly_email_limit')
      .single()

    if (error || !data) {
      res.status(404).json({ error: error?.message ?? 'Mailbox not found' })
      return
    }

    res.json(data)
  } catch (err) {
    next(err)
  }
})

export default router
