import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'

const router = Router()
router.use(authMiddleware)

/**
 * @swagger
 * /companies:
 *   get:
 *     summary: List all companies the current user belongs to
 *     tags: [Companies]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of company objects
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_companies')
      .select('company:companies(id, name, website, industry)')
      .eq('user_id', req.user.id)
      .order('created_at')
    if (error) {
      res.status(400).json({ error: error.message })
      return
    }
    const companies = (data ?? []).map((row: { company: unknown }) => row.company).filter(Boolean)
    res.json(companies)
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /companies:
 *   post:
 *     summary: Create a new company and add the current user as member
 *     tags: [Companies]
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
 *         description: Company created
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body)

    const { data: company, error: companyErr } = await supabaseAdmin
      .from('companies')
      .insert({ name })
      .select()
      .single()
    if (companyErr || !company) {
      res.status(400).json({ error: companyErr?.message ?? 'Failed to create company' })
      return
    }

    await supabaseAdmin
      .from('user_companies')
      .insert({ user_id: req.user.id, company_id: company.id })

    res.status(201).json(company)
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors[0]?.message })
      return
    }
    next(err)
  }
})

export default router
