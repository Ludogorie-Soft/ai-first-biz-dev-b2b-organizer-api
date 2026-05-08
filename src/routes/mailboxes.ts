import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'
import { encrypt } from '../utils/encrypt'
import { sesClient } from '../config/ses'
import { SendEmailCommand } from '@aws-sdk/client-ses'
import { getDailyLimit } from '../utils/warmup'

const router = Router()
router.use(authMiddleware)

const imapConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().positive(),
  tls: z.boolean().default(true),
  user: z.string(),
  password: z.string(),
})

const mailboxSchema = z.object({
  email: z.string().email(),
  imap_config: imapConfigSchema,
})

/**
 * @swagger
 * /mailboxes:
 *   get:
 *     summary: List mailboxes (imap_config omitted for security)
 *     tags: [Mailboxes]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of mailbox objects without imap_config
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('mailboxes')
      .select('id, email, ses_status, is_paused, warmup_started_at, created_at, daily_email_limit, weekly_email_limit')
      .eq('company_id', req.user.company_id)
      .order('created_at')
    if (error) {
      res.status(400).json({ error: error.message })
      return
    }

    const result = (data ?? []).map((mb: any) => {
      const effectiveDailyLimit = getDailyLimit(
        mb.warmup_started_at ? new Date(mb.warmup_started_at) : null,
        mb.daily_email_limit
      )
      return {
        ...mb,
        effective_daily_limit: effectiveDailyLimit,
        is_warming_up: effectiveDailyLimit < mb.daily_email_limit,
      }
    })

    res.json(result)
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /mailboxes:
 *   post:
 *     summary: Add a mailbox (imap_config encrypted at rest)
 *     tags: [Mailboxes]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, imap_config]
 *             properties:
 *               email: { type: string }
 *               imap_config:
 *                 type: object
 *                 required: [host, port, user, password]
 *                 properties:
 *                   host: { type: string }
 *                   port: { type: integer }
 *                   tls: { type: boolean }
 *                   user: { type: string }
 *                   password: { type: string }
 *     responses:
 *       201:
 *         description: Mailbox created
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = mailboxSchema.parse(req.body)
    const encryptedConfig = encrypt(body.imap_config)
    const { data, error } = await supabaseAdmin
      .from('mailboxes')
      .insert({ company_id: req.user.company_id, email: body.email, imap_config: encryptedConfig, ses_status: 'pending' })
      .select('id, email, ses_status, created_at')
      .single()
    if (error) {
      res.status(400).json({ error: error.message })
      return
    }

    // Notify all global admins about the new pending mailbox
    notifyAdminsNewMailbox(body.email, req.user.company_id).catch((e: Error) =>
      console.error('[Mailboxes] Failed to notify admins:', e.message)
    )

    res.status(201).json(data)
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors })
      return
    }
    next(err)
  }
})

async function notifyAdminsNewMailbox(mailboxEmail: string, companyId: string): Promise<void> {
  // Get company name
  const { data: company } = await supabaseAdmin
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .single()

  // Get all global admins
  const { data: admins } = await supabaseAdmin
    .from('users')
    .select('email')
    .eq('role', 'global_admin')

  if (!admins || admins.length === 0) return

  const companyName = company?.name ?? 'Unknown company'
  const adminEmails = admins.map((a: { email: string }) => a.email)

  await sesClient.send(new SendEmailCommand({
    Source: process.env.SES_FROM_EMAIL!,
    Destination: { ToAddresses: adminEmails },
    Message: {
      Subject: { Data: `[BizDev B2B] New mailbox pending SES approval: ${mailboxEmail}`, Charset: 'UTF-8' },
      Body: {
        Html: {
          Charset: 'UTF-8',
          Data: `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px">
              <h2 style="color:#1e293b">New mailbox awaiting SES approval</h2>
              <p style="color:#475569">A new sender mailbox was just registered and needs to be added to AWS SES before it can be used.</p>
              <table style="width:100%;border-collapse:collapse;margin:20px 0">
                <tr>
                  <td style="padding:8px 0;color:#64748b;font-size:14px">Mailbox</td>
                  <td style="padding:8px 0;color:#1e293b;font-weight:600;font-size:14px">${mailboxEmail}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#64748b;font-size:14px">Company</td>
                  <td style="padding:8px 0;color:#1e293b;font-weight:600;font-size:14px">${companyName}</td>
                </tr>
              </table>
              <p style="color:#475569;font-size:14px">Once you add this address to SES, approve it in the admin panel so associated campaigns can start sending.</p>
              <a href="${process.env.FRONTEND_URL}/admin" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">
                Open Admin Panel
              </a>
            </div>`,
        },
      },
    },
  }))
}

/**
 * @swagger
 * /mailboxes/{id}:
 *   delete:
 *     summary: Remove a mailbox
 *     tags: [Mailboxes]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Deleted
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid mailbox ID' })
    return
  }
  if (!['owner', 'admin', 'global_admin'].includes(req.user.role)) {
    res.status(403).json({ error: 'Only owners and admins can delete mailboxes' })
    return
  }
  try {
    const { error } = await supabaseAdmin
      .from('mailboxes')
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
