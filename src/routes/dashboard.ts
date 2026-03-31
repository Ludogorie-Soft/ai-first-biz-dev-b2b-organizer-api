import { Router, Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'
import { ReplyCategory } from '../types'

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
    // Verify campaign belongs to company
    const { data: campaign, error: campErr } = await supabaseAdmin
      .from('campaigns')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .single()
    if (campErr || !campaign) {
      res.status(404).json({ error: 'Campaign not found' })
      return
    }

    const { data: logs, error: logsErr } = await supabaseAdmin
      .from('email_logs')
      .select('status, reply_category')
      .eq('campaign_id', req.params.id)
    if (logsErr) {
      res.status(400).json({ error: logsErr.message })
      return
    }

    const stats: CampaignStats = {
      sent: 0,
      pending: 0,
      failed: 0,
      replied: 0,
      reply_breakdown: { positive: 0, negative: 0, neutral: 0, out_of_office: 0 },
    }

    for (const log of (logs ?? []) as EmailLog[]) {
      if (log.status === 'sent') stats.sent++
      else if (log.status === 'pending') stats.pending++
      else if (log.status === 'failed') stats.failed++
      if (log.reply_category) {
        stats.replied++
        stats.reply_breakdown[log.reply_category] =
          (stats.reply_breakdown[log.reply_category] ?? 0) + 1
      }
    }

    res.json(stats)
  } catch (err) {
    next(err)
  }
})

export default router
