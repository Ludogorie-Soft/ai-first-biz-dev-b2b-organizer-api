import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'

const router = Router()
router.use(authMiddleware)

/**
 * @swagger
 * /sequences:
 *   get:
 *     summary: List sequences with their steps
 *     tags: [Sequences]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of sequence objects with nested steps
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('sequences')
      .select('*, sequence_steps(*)')
      .eq('company_id', req.user.company_id)
      .order('created_at')
      .order('step_order', { referencedTable: 'sequence_steps' })
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
 * /sequences:
 *   post:
 *     summary: Create a new sequence
 *     tags: [Sequences]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *     responses:
 *       201:
 *         description: Sequence created
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schema = z.object({ name: z.string().min(1) })
    const body = schema.parse(req.body)
    const { data, error } = await supabaseAdmin
      .from('sequences')
      .insert({ name: body.name, company_id: req.user.company_id })
      .select()
      .single()
    if (error) {
      res.status(400).json({ error: error.message })
      return
    }
    res.status(201).json(data)
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
 * /sequences/{id}/steps:
 *   post:
 *     summary: Add a step to a sequence
 *     tags: [Sequences]
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
 *             required: [step_order, subject, body]
 *             properties:
 *               step_order: { type: integer }
 *               subject: { type: string }
 *               body: { type: string }
 *               delay_days: { type: integer, default: 0 }
 *     responses:
 *       201:
 *         description: Step created
 *       404:
 *         description: Sequence not found
 */
router.post('/:id/steps', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schema = z.object({
      step_order: z.number().int().positive(),
      subject: z.string().min(1),
      body: z.string().min(1),
      delay_days: z.number().int().min(0).default(0),
    })
    const body = schema.parse(req.body)

    // Verify sequence belongs to company
    const { data: seq, error: seqErr } = await supabaseAdmin
      .from('sequences')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .single()
    if (seqErr || !seq) {
      res.status(404).json({ error: 'Sequence not found' })
      return
    }

    const { data, error } = await supabaseAdmin
      .from('sequence_steps')
      .insert({ sequence_id: req.params.id, ...body })
      .select()
      .single()
    if (error) {
      res.status(400).json({ error: error.message })
      return
    }
    res.status(201).json(data)
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors })
      return
    }
    next(err)
  }
})

export default router
