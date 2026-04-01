import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'
import { emailQueue } from '../queues/emailQueue'
import { EmailJobData } from '../types'

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
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .select('*, campaign_sequences(sequence_id), campaign_mailboxes(mailbox_id)')
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false })
    if (error) {
      res.status(400).json({ error: error.message })
      return
    }
    res.json(data)
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
    })
    const body = schema.parse(req.body)

    // 1. Create campaign
    const { data: campaign, error: campErr } = await supabaseAdmin
      .from('campaigns')
      .insert({
        company_id: req.user.company_id,
        target_group_id: body.target_group_id,
        name: body.name,
        description: body.description,
        status: 'active',
      })
      .select()
      .single()
    if (campErr) {
      res.status(400).json({ error: campErr.message })
      return
    }

    // 2. Link sequences
    await supabaseAdmin.from('campaign_sequences').insert(
      body.sequence_ids.map((seq_id) => ({ campaign_id: campaign.id, sequence_id: seq_id }))
    )

    // 3. Link mailboxes
    await supabaseAdmin.from('campaign_mailboxes').insert(
      body.mailbox_ids.map((mb_id) => ({ campaign_id: campaign.id, mailbox_id: mb_id }))
    )

    // 4. For each sequence, get step 1 and enqueue jobs for all active leads
    // Leads are round-robin assigned across mailboxes
    const { data: leads } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('target_group_id', body.target_group_id)
      .eq('company_id', req.user.company_id)
      .eq('status', 'active')

    if (leads && leads.length > 0) {
      for (const sequenceId of body.sequence_ids) {
        const { data: firstStep } = await supabaseAdmin
          .from('sequence_steps')
          .select('id')
          .eq('sequence_id', sequenceId)
          .order('step_order')
          .limit(1)
          .single()

        if (!firstStep) continue

        const jobs = leads.map((lead: { id: string }, idx: number) => ({
          name: `send-${lead.id}-${sequenceId}-step1`,
          data: {
            campaignId: campaign.id as string,
            sequenceId,
            stepId: firstStep.id as string,
            leadId: lead.id,
            // Round-robin mailbox assignment
            mailboxId: body.mailbox_ids[idx % body.mailbox_ids.length],
          } satisfies EmailJobData,
        }))
        await emailQueue.addBulk(jobs)
      }
    }

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
      })
      .refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' })
    const body = schema.parse(req.body)

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

export default router
