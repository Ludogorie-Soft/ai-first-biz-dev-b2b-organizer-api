import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { sesClient } from '../config/ses'
import { SendEmailCommand } from '@aws-sdk/client-ses'
import { authMiddleware } from '../middleware/auth'

const router = Router()

// ── Invitations ───────────────────────────────────────────────────────────

router.get('/invitations', authMiddleware, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('invitations')
      .select('id, email, expires_at, created_at')
      .eq('company_id', req.user.company_id)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
    if (error) { res.status(400).json({ error: error.message }); return }
    res.json(data)
  } catch (err) { next(err) }
})

router.post('/invitations', authMiddleware, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body)

    // Don't invite someone already in the org
    const { data: existing } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('company_id', req.user.company_id)
      .eq('email', email)
      .maybeSingle()
    if (existing) {
      console.log('[Invitations] User already exists:', email)
      res.status(400).json({ error: 'This email is already a member of your organisation' })
      return
    }

    // Replace any existing pending invite for the same email
    const { error: deleteErr } = await supabaseAdmin.from('invitations').delete()
      .eq('company_id', req.user.company_id).eq('email', email)
    
    if (deleteErr) {
      console.error('[Invitations] Failed to delete old invitation:', deleteErr)
    } else {
      console.log('[Invitations] Deleted any existing invitations for:', email)
    }

    const { data: inv, error: invErr } = await supabaseAdmin
      .from('invitations')
      .insert({ company_id: req.user.company_id, email, invited_by: req.user.id })
      .select('token')
      .single()
    if (invErr || !inv) { 
      console.error('[Invitations] Failed to create invitation:', invErr)
      res.status(400).json({ error: invErr?.message ?? 'Failed to create invitation' })
      return 
    }

    console.log('[Invitations] Created invitation for:', email, 'token:', inv.token)

    const { data: company } = await supabaseAdmin
      .from('companies').select('name').eq('id', req.user.company_id).single()

    const acceptUrl = `${process.env.FRONTEND_URL}/accept-invite?token=${inv.token}`
    console.log('[Invitations] Accept URL:', acceptUrl)

    await sesClient.send(new SendEmailCommand({
      Source: process.env.SES_FROM_EMAIL!,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: `You're invited to join ${company?.name ?? 'an organisation'}`, Charset: 'UTF-8' },
        Body: {
          Html: {
            Charset: 'UTF-8',
            Data: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
              <h2 style="color:#1e293b">You've been invited</h2>
              <p style="color:#475569"><strong>${req.user.email}</strong> invited you to join <strong>${company?.name}</strong>.</p>
              <a href="${acceptUrl}" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Accept invitation</a>
              <p style="margin-top:24px;color:#94a3b8;font-size:12px">This invitation expires in 24 hours.</p>
            </div>`,
          },
        },
      },
    })).catch((e: Error) => console.error('[Org] invite email error:', e.message))

    res.status(201).json({ message: 'Invitation sent' })
  } catch (err) {
    if (err instanceof ZodError) { res.status(400).json({ error: err.errors[0]?.message }); return }
    next(err)
  }
})

router.delete('/invitations/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { error } = await supabaseAdmin
      .from('invitations').delete().eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
    if (error) { res.status(400).json({ error: error.message }); return }
    res.status(204).send()
  } catch (err) { next(err) }
})

// ── Accept invitation — new user registers via invite link ────────────────

router.post('/accept-invite/register', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { token, password } = z.object({
      token: z.string().uuid(),
      password: z.string().min(8),
    }).parse(req.body)

    const { data: inv } = await supabaseAdmin
      .from('invitations')
      .select('id, company_id, email, expires_at')
      .eq('token', token)
      .single()

    if (!inv) { res.status(400).json({ error: 'Invalid or expired invitation' }); return }
    if (new Date(inv.expires_at) < new Date()) {
      await supabaseAdmin.from('invitations').delete().eq('id', inv.id)
      res.status(400).json({ error: 'Invitation has expired' })
      return
    }

    // Check if user already exists in our database (from a previous failed attempt)
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', inv.email)
      .maybeSingle()
    
    if (existingUser) {
      console.log('[AcceptInvite] User profile already exists, deleting:', existingUser.id)
      // Delete both auth user and profile from previous failed attempt
      await supabaseAdmin.auth.admin.deleteUser(existingUser.id)
      await supabaseAdmin.from('users').delete().eq('id', existingUser.id)
    }

    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email: inv.email,
      password,
      email_confirm: true, // verified implicitly via invite link
    })
    
    if (authErr) {
      console.error('[AcceptInvite] Failed to create auth user:', authErr)
      // If user already exists, provide helpful error message
      if (authErr.message?.includes('already registered') || authErr.message?.includes('already exists')) {
        res.status(400).json({ 
          error: 'This email is already registered. Please contact your administrator to remove the old account first.' 
        })
      } else {
        res.status(400).json({ error: authErr.message })
      }
      return 
    }

    console.log('[AcceptInvite] Created auth user:', authData.user.id, inv.email)

    // All invited users get owner-level access
    const { error: insertErr } = await supabaseAdmin.from('users')
      .insert({ id: authData.user.id, company_id: inv.company_id, role: 'owner', email: inv.email })
    
    if (insertErr) {
      console.error('[AcceptInvite] Failed to insert user profile:', insertErr)
      // Rollback: delete the auth user and keep the invitation so they can try again
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id)
      // Don't delete the invitation - they should be able to retry with the same link
      res.status(400).json({ error: `Failed to create user profile: ${insertErr.message}` })
      return
    }

    console.log('[AcceptInvite] Created user profile for company:', inv.company_id)

    // Only delete the invitation after successful registration
    await supabaseAdmin.from('invitations').delete().eq('id', inv.id)

    const { data: session } = await supabaseAdmin.auth.signInWithPassword({ email: inv.email, password })
    res.status(201).json({
      access_token: session?.session?.access_token,
      refresh_token: session?.session?.refresh_token,
      user: { id: authData.user.id, email: inv.email },
    })
  } catch (err) {
    if (err instanceof ZodError) { res.status(400).json({ error: err.errors[0]?.message }); return }
    next(err)
  }
})

// ── Check invitation details (public) ────────────────────────────────────

router.get('/invitations/check', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = z.string().uuid().parse(req.query.token)
    const { data: inv } = await supabaseAdmin
      .from('invitations')
      .select('email, expires_at, companies(name)')
      .eq('token', token)
      .single()

    if (!inv || new Date(inv.expires_at) < new Date()) {
      res.status(404).json({ error: 'Invalid or expired invitation' })
      return
    }
    const companies = inv.companies as unknown as { name: string } | null
    res.json({ email: inv.email, company_name: companies?.name })
  } catch (err) {
    if (err instanceof ZodError) { res.status(400).json({ error: 'Invalid token' }); return }
    next(err)
  }
})

// ── Members management ────────────────────────────────────────────────────

router.delete('/members/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (req.params.id === req.user.id) {
    res.status(400).json({ error: 'You cannot remove yourself' })
    return
  }
  try {
    const { data: member } = await supabaseAdmin
      .from('users').select('id').eq('id', req.params.id as string)
      .eq('company_id', req.user.company_id).single()
    if (!member) { res.status(404).json({ error: 'Member not found' }); return }

    await supabaseAdmin.auth.admin.deleteUser(req.params.id as string)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
