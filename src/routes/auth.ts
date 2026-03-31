import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'

const router = Router()

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  company_name: z.string().min(1),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new company and admin user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, company_name]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *               company_name: { type: string }
 *     responses:
 *       201:
 *         description: Registered successfully
 *       400:
 *         description: Validation error
 */
router.post('/register', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = registerSchema.parse(req.body)

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
    })
    if (authError) {
      res.status(400).json({ error: authError.message })
      return
    }

    const { data: company, error: companyError } = await supabaseAdmin
      .from('companies')
      .insert({ name: body.company_name })
      .select()
      .single()
    if (companyError) {
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id)
      res.status(400).json({ error: companyError.message })
      return
    }

    const { error: userError } = await supabaseAdmin
      .from('users')
      .insert({ id: authData.user.id, company_id: company.id, role: 'owner', email: body.email })
    if (userError) {
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id)
      res.status(400).json({ error: userError.message })
      return
    }

    res.status(201).json({ message: 'Registered successfully. Please sign in.' })
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
 * /auth/login:
 *   post:
 *     summary: Sign in with email and password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Returns access_token and refresh_token
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = loginSchema.parse(req.body)
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    })
    if (error) {
      res.status(401).json({ error: error.message })
      return
    }
    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      user: { id: data.user.id, email: data.user.email },
    })
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors })
      return
    }
    next(err)
  }
})

export default router
