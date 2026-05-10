import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'
import { computeCampaignListProgress, computeCampaignReplyStats } from '../utils/campaignListAggregates'

const router = Router()
router.use(authMiddleware)

/**
 * @swagger
 * /campaigns:
 *   get:
 *     summary: List campaigns with linked sequences and mailboxes
 *     tags: [Campaigns]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of campaign objects
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    let query = supabaseAdmin
      .from('campaigns')
      .select('*, target_group:target_groups(name), campaign_sequences(sequence_id, sequence:sequences(name)), campaign_mailboxes(mailbox_id), leads(count)')
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false })
    if (req.query.target_group_id) {
      query = query.eq('target_group_id', req.query.target_group_id as string)
    }
    const { data, error } = await query
    if (error) {
      res.status(400).json({ error: error.message })
      return
    }

    const rows = (data ?? []) as Record<string, unknown>[]
    const ids = rows.map((r) => r.id as string)
    const [progressMap, replyMap] = await Promise.all([
      computeCampaignListProgress(ids),
      computeCampaignReplyStats(ids),
    ])

    const enriched = rows.map((c) => {
      const id = c.id as string
      const p = progressMap.get(id) ?? { steps_total: 0, steps_executed: 0 }
      const r = replyMap.get(id) ?? { total: 0, positive: 0 }
      const leadsEmb = c.leads as { count?: number }[] | undefined
      const contacts_count = Number(leadsEmb?.[0]?.count ?? 0)
      return {
        ...c,
        contacts_count,
        steps_executed: p.steps_executed,
        steps_total: p.steps_total,
        replies_count: r.total,
        positive_replies_count: r.positive,
      }
    })

    res.json(enriched)
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /campaigns:
 *   post:
 *     summary: Create a campaign and enqueue email jobs for all active leads
 *     tags: [Campaigns]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, target_group_id, sequence_ids, mailbox_ids]
 *             properties:
 *               name: { type: string }
 *               target_group_id: { type: string }
 *               description: { type: string }
 *               sequence_ids:
 *                 type: array
 *                 items: { type: string }
 *               mailbox_ids:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       201:
 *         description: Campaign created and email jobs enqueued
 *       400:
 *         description: Validation error
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schema = z.object({
      name: z.string().min(1),
      target_group_id: z.string().uuid(),
      description: z.string().optional(),
      sequence_ids: z.array(z.string().uuid()).min(1),
      mailbox_ids: z.array(z.string().uuid()).min(1),
      send_on_weekends: z.boolean().optional().default(false),
    })
    const body = schema.parse(req.body)

    // 1. Check if any selected mailboxes are still pending SES approval
    const { data: mailboxes, error: mbErr } = await supabaseAdmin
      .from('mailboxes')
      .select('id, ses_status')
      .in('id', body.mailbox_ids)
      .eq('company_id', req.user.company_id)
    if (mbErr) {
      res.status(400).json({ error: mbErr.message })
      return
    }
    if (!mailboxes || mailboxes.length !== body.mailbox_ids.length) {
      res.status(400).json({ error: 'One or more mailboxes not found' })
      return
    }
    const hasPendingMailbox = mailboxes.some((mb: { ses_status: string }) => mb.ses_status === 'pending')
    const campaignStatus = hasPendingMailbox ? 'pending_mailbox_approval' : 'active'

    // 2. Create campaign
    const { data: campaign, error: campErr } = await supabaseAdmin
      .from('campaigns')
      .insert({
        company_id: req.user.company_id,
        target_group_id: body.target_group_id,
        name: body.name,
        description: body.description,
        status: campaignStatus,
        send_on_weekends: body.send_on_weekends,
      })
      .select()
      .single()
    if (campErr) {
      res.status(400).json({ error: campErr.message })
      return
    }

    // 3. Link sequences
    await supabaseAdmin.from('campaign_sequences').insert(
      body.sequence_ids.map((seq_id) => ({ campaign_id: campaign.id, sequence_id: seq_id }))
    )

    // 4. Link mailboxes
    await supabaseAdmin.from('campaign_mailboxes').insert(
      body.mailbox_ids.map((mb_id) => ({ campaign_id: campaign.id, mailbox_id: mb_id }))
    )

    res.status(201).json(campaign)
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors })
      return
    }
    next(err)
  }
})

/**
 * @swagger
 * /campaigns/{id}:
 *   get:
 *     summary: Get a single campaign
 *     tags: [Campaigns]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Campaign object
 *       404:
 *         description: Not found
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid campaign ID' })
    return
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .select('*, campaign_sequences(sequence_id), campaign_mailboxes(mailbox_id)')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .single()
    if (error || !data) {
      res.status(404).json({ error: 'Campaign not found' })
      return
    }
    res.json(data)
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /campaigns/{id}:
 *   patch:
 *     summary: Update campaign status or details
 *     tags: [Campaigns]
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
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [active, paused, completed]
 *               name: { type: string }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: Updated campaign
 *       404:
 *         description: Campaign not found
 */
router.patch('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid campaign ID' })
    return
  }
  try {
    const schema = z
      .object({
        status: z.enum(['active', 'paused', 'completed']).optional(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        send_on_weekends: z.boolean().optional(),
      })
      .refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' })
    const body = schema.parse(req.body)

    // Prevent manually activating a campaign stuck on mailbox approval
    if (body.status === 'active') {
      const { data: current } = await supabaseAdmin
        .from('campaigns')
        .select('status')
        .eq('id', req.params.id)
        .eq('company_id', req.user.company_id)
        .single()
      if (current?.status === 'pending_mailbox_approval') {
        res.status(400).json({ error: 'Campaign cannot be activated until all mailboxes are approved in SES' })
        return
      }
    }

    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .update(body)
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .select()
      .single()
    if (error || !data) {
      res.status(404).json({ error: 'Campaign not found' })
      return
    }
    res.json(data)
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors })
      return
    }
    next(err)
  }
})

/**
 * @swagger
 * /campaigns/{id}:
 *   delete:
 *     summary: Delete a paused or draft campaign
 *     tags: [Campaigns]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Deleted
 *       400:
 *         description: Campaign must be paused or draft before deleting
 *       404:
 *         description: Not found
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid campaign ID' })
    return
  }
  try {
    // Fetch first to verify ownership and status
    const { data: campaign, error: fetchErr } = await supabaseAdmin
      .from('campaigns')
      .select('id, status')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .single()

    if (fetchErr || !campaign) {
      res.status(404).json({ error: 'Campaign not found' })
      return
    }

    if (!['paused', 'draft'].includes(campaign.status)) {
      res.status(400).json({ error: 'Only paused or draft campaigns can be deleted' })
      return
    }

    const { error } = await supabaseAdmin
      .from('campaigns')
      .delete()
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)

    if (error) {
      res.status(400).json({ error: error.message })
      return
    }

    res.status(204).send()
  } catch (err) {
    next(err)
  }
})

export default router
