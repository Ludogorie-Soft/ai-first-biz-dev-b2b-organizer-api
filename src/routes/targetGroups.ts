import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'

const router = Router()
router.use(authMiddleware)

/**
 * @swagger
 * /target-groups:
 *   get:
 *     summary: List target groups
 *     tags: [Target Groups]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of target group objects
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('target_groups')
      .select('*, leads(count)')
      .eq('company_id', req.user.company_id)
      .order('created_at')
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
 * /target-groups:
 *   post:
 *     summary: Create a target group
 *     tags: [Target Groups]
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
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: Target group created
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schema = z.object({ name: z.string().min(1), description: z.string().optional() })
    const body = schema.parse(req.body)
    const { data, error } = await supabaseAdmin
      .from('target_groups')
      .insert({ ...body, company_id: req.user.company_id })
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
 * /target-groups/{id}:
 *   delete:
 *     summary: Delete a target group
 *     tags: [Target Groups]
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
 *         description: Cannot delete — group is linked to a campaign
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid target group ID' })
    return
  }
  try {
    const { error } = await supabaseAdmin
      .from('target_groups')
      .delete()
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
    if (error) {
      // FK violation means the group is still linked to a campaign
      const msg = error.code === '23503'
        ? 'Cannot delete — this target group is used by one or more campaigns'
        : error.message
      res.status(400).json({ error: msg })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
})

export default router
