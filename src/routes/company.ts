import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'

const router = Router()
router.use(authMiddleware)

/**
 * @swagger
 * /company:
 *   get:
 *     summary: Get company profile
 *     tags: [Company]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Company object
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('companies')
      .select('*')
      .eq('id', req.user.company_id)
      .single()
    if (error) {
      res.status(404).json({ error: error.message })
      return
    }
    res.json(data)
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /company:
 *   patch:
 *     summary: Update company profile
 *     tags: [Company]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               website: { type: string }
 *               industry: { type: string }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: Updated company object
 */
router.patch('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!['owner', 'admin'].includes(req.user.role)) {
    res.status(403).json({ error: 'Only owners and admins can update the company profile' })
    return
  }
  try {
    const schema = z.object({
      name: z.string().min(1).optional(),
      website: z.string().url().optional(),
      industry: z.string().optional(),
      description: z.string().optional(),
    })
    const body = schema.parse(req.body)
    const { data, error } = await supabaseAdmin
      .from('companies')
      .update(body)
      .eq('id', req.user.company_id)
      .select()
      .single()
    if (error) {
      res.status(400).json({ error: error.message })
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
 * /company/users:
 *   get:
 *     summary: List all team members
 *     tags: [Company]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of user objects
 */
router.get('/users', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, email, role, created_at')
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

export default router
