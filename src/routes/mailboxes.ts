import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'
import { encrypt } from '../utils/encrypt'

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
      .select('id, email, is_paused, warmup_started_at, created_at')
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
      .insert({ company_id: req.user.company_id, email: body.email, imap_config: encryptedConfig })
      .select('id, email, created_at')
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
  if (!['owner', 'admin'].includes(req.user.role)) {
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
