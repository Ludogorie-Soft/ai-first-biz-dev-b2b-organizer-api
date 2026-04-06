import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { sesClient } from '../config/ses'
import { SendEmailCommand } from '@aws-sdk/client-ses'

const router = Router()

async function sendVerificationEmail(userId: string, email: string): Promise<void> {
  const { data: verification } = await supabaseAdmin
    .from('email_verifications')
    .insert({ user_id: userId })
    .select('token')
    .single()
  if (!verification) return
  const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verification.token}`
  await sesClient.send(new SendEmailCommand({
    Source: process.env.SES_FROM_EMAIL!,
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: 'Verify your email', Charset: 'UTF-8' },
      Body: {
        Html: {
          Charset: 'UTF-8',
          Data: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
              <h2 style="color:#1e293b">Verify your email</h2>
              <p style="color:#475569">Click the button below to activate your account. The link expires in 24 hours.</p>
              <a href="${verifyUrl}" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">
                Verify email
              </a>
              <p style="margin-top:24px;color:#94a3b8;font-size:12px">If you didn't create an account, you can ignore this email.</p>
            </div>`,
        },
      },
    },
  })).catch((e: Error) => console.error('[Auth] Failed to send verification email:', e.message))
}

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
      email_confirm: false,
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

    await supabaseAdmin
      .from('user_companies')
      .insert({ user_id: authData.user.id, company_id: company.id })

    await sendVerificationEmail(authData.user.id, body.email)

    res.status(201).json({ message: 'Registered successfully. Please verify your email.' })
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors[0]?.message ?? 'Validation error' })
      return
    }
    next(err)
  }
})

router.post('/verify-email', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { token } = z.object({ token: z.string().uuid() }).parse(req.body)

    const { data: verification, error } = await supabaseAdmin
      .from('email_verifications')
      .select('user_id, expires_at')
      .eq('token', token)
      .single()

    if (error || !verification) {
      res.status(400).json({ error: 'Invalid or expired verification link.' })
      return
    }

    if (new Date(verification.expires_at) < new Date()) {
      await supabaseAdmin.from('email_verifications').delete().eq('token', token)
      res.status(400).json({ error: 'Verification link has expired. Please register again.' })
      return
    }

    await supabaseAdmin.auth.admin.updateUserById(verification.user_id, { email_confirm: true })
    await supabaseAdmin.from('email_verifications').delete().eq('token', token)

    res.json({ message: 'Email verified. You can now sign in.' })
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Invalid token.' })
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
      res.status(400).json({ error: err.errors[0]?.message ?? 'Validation error' })
      return
    }
    next(err)
  }
})

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Refresh an expired access token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refresh_token]
 *             properties:
 *               refresh_token: { type: string }
 *     responses:
 *       200:
 *         description: New access_token and refresh_token
 *       401:
 *         description: Invalid or expired refresh token
 */
router.post('/refresh', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { refresh_token } = z.object({ refresh_token: z.string().min(1) }).parse(req.body)
    const { data, error } = await supabaseAdmin.auth.refreshSession({ refresh_token })
    if (error || !data.session) {
      res.status(401).json({ error: error?.message ?? 'Invalid refresh token' })
      return
    }
    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
    })
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors[0]?.message ?? 'Validation error' })
      return
    }
    next(err)
  }
})

export default router
