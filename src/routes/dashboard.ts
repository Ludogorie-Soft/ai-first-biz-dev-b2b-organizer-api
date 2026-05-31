import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'
import { ReplyCategory } from '../types'
import { checkAndCompleteCampaign, computeCampaignSequenceProgress } from '../utils/campaignCompletion'

const router = Router()
router.use(authMiddleware)

interface EmailLog {
  status: string
  reply_category: ReplyCategory | null
}

interface CampaignStats {
  sent: number
  pending: number
  failed: number
  replied: number
  reply_breakdown: Record<ReplyCategory, number>
  steps_total: number
  steps_executed: number
  campaign_status: string
}

/**
 * @swagger
 * /campaigns/{id}/stats:
 *   get:
 *     summary: Get campaign delivery and reply statistics
 *     tags: [Dashboard]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Campaign UUID
 *     responses:
 *       200:
 *         description: Campaign stats object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sent: { type: integer }
 *                 pending: { type: integer }
 *                 failed: { type: integer }
 *                 replied: { type: integer }
 *                 reply_breakdown:
 *                   type: object
 *                   properties:
 *                     positive: { type: integer }
 *                     negative: { type: integer }
 *                     neutral: { type: integer }
 *                     out_of_office: { type: integer }
 *       404:
 *         description: Campaign not found
 */
router.get('/:id/stats', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      res.status(400).json({ error: 'Invalid campaign ID' })
      return
    }
    const campaignId = req.params.id as string

    // Verify campaign belongs to company
    const { data: campaign, error: campErr } = await supabaseAdmin
      .from('campaigns')
      .select('id, status')
      .eq('id', campaignId)
      .eq('company_id', req.user.company_id)
      .single()
    if (campErr || !campaign) {
      res.status(404).json({ error: 'Campaign not found' })
      return
    }

    const { data: logs, error: logsErr } = await supabaseAdmin
      .from('email_logs')
      .select('status, reply_category')
      .eq('campaign_id', campaignId)
    if (logsErr) {
      res.status(400).json({ error: logsErr.message })
      return
    }

    const logStats = {
      sent: 0,
      pending: 0,
      failed: 0,
      replied: 0,
      reply_breakdown: { positive: 0, negative: 0, neutral: 0, out_of_office: 0 } as Record<
        ReplyCategory,
        number
      >,
    }

    for (const log of (logs ?? []) as EmailLog[]) {
      if (log.status === 'sent') logStats.sent++
      else if (log.status === 'pending') logStats.pending++
      else if (log.status === 'failed') logStats.failed++
      if (log.reply_category) {
        logStats.replied++
        logStats.reply_breakdown[log.reply_category] =
          (logStats.reply_breakdown[log.reply_category] ?? 0) + 1
      }
    }

    const progress = await computeCampaignSequenceProgress(campaignId)

    let campaignStatus = (campaign as { status: string }).status
    if (
      campaignStatus === 'active' &&
      progress.steps_total > 0 &&
      progress.steps_executed >= progress.steps_total
    ) {
      await checkAndCompleteCampaign(campaignId)
      const { data: freshCamp } = await supabaseAdmin
        .from('campaigns')
        .select('status')
        .eq('id', campaignId)
        .eq('company_id', req.user.company_id)
        .single()
      if (freshCamp) campaignStatus = (freshCamp as { status: string }).status
    }

    const payload: CampaignStats = {
      ...logStats,
      steps_total: progress.steps_total,
      steps_executed: progress.steps_executed,
      campaign_status: campaignStatus,
    }

    res.json(payload)
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /campaigns/{id}/email-logs:
 *   get:
 *     summary: Paginated sending history for a campaign
 *     tags: [Dashboard]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [sent, failed] }
 *     responses:
 *       200:
 *         description: Paginated email log entries
 */
router.get('/:id/email-logs', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      res.status(400).json({ error: 'Invalid campaign ID' })
      return
    }
    const campaignId = req.params.id as string

    const querySchema = z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(['sent', 'failed']).optional(),
    })
    const { page, limit, status } = querySchema.parse(req.query)
    const offset = (page - 1) * limit

    // Verify campaign belongs to the requesting company
    const { data: campaign, error: campErr } = await supabaseAdmin
      .from('campaigns')
      .select('id')
      .eq('id', campaignId)
      .eq('company_id', req.user.company_id)
      .single()
    if (campErr || !campaign) {
      res.status(404).json({ error: 'Campaign not found' })
      return
    }

    // Build query — join leads, sequence_steps and mailboxes for rich display
    let query = supabaseAdmin
      .from('email_logs')
      .select(
        `id,
         status,
         sent_subject,
         sent_at,
         reply_category,
         lead:leads(id, email, first_name, last_name),
         step:sequence_steps(step_order),
         mailbox:mailboxes(email)`,
        { count: 'exact' }
      )
      .eq('campaign_id', campaignId)
      .order('sent_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) {
      query = query.eq('status', status)
    }

    const { data, error, count } = await query

    if (error) {
      res.status(400).json({ error: error.message })
      return
    }

    res.json({ data: data ?? [], total: count ?? 0, page, limit })
  } catch (err) {
    next(err)
  }
})

export default router
