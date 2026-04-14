import { Router, Request, Response, NextFunction } from 'express'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'

const router = Router()

/**
 * POST /unsubscribe
 *
 * Handles two callers:
 *   1. Frontend page  — sends JSON body { token: "uuid" }
 *   2. Email clients  — RFC 8058 one-click: POSTs to /unsubscribe?token=uuid
 *                       with body "List-Unsubscribe=One-Click" (urlencoded)
 *
 * No authentication required — the token is the credential.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Accept token from JSON body or query string (RFC 8058 one-click)
    const rawToken = req.body?.token ?? req.query?.token
    const { token } = z.object({ token: z.string().uuid() }).parse({ token: rawToken })

    // Look up the token
    const { data: record, error } = await supabaseAdmin
      .from('unsubscribe_tokens')
      .select('lead_id, company_id')
      .eq('token', token)
      .single()

    if (error || !record) {
      res.status(400).json({ error: 'invalid_token' })
      return
    }

    // Get the lead's email so we can suppress the entire address company-wide
    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('email')
      .eq('id', record.lead_id)
      .single()

    if (!lead) {
      res.status(400).json({ error: 'invalid_token' })
      return
    }

    // Mark every lead record with this email+company as unsubscribed.
    // The worker already skips leads with status != 'active', so all
    // pending BullMQ jobs for this address will be silently dropped.
    await supabaseAdmin
      .from('leads')
      .update({ status: 'unsubscribed' })
      .eq('company_id', record.company_id)
      .eq('email', lead.email)
      .neq('status', 'unsubscribed') // avoid unnecessary writes

    // Persist to suppression list so future imports of this email
    // are immediately marked unsubscribed even after leads are deleted.
    await supabaseAdmin
      .from('suppressed_emails')
      .upsert({ company_id: record.company_id, email: lead.email }, { onConflict: 'company_id,email', ignoreDuplicates: true })

    res.json({ message: 'unsubscribed' })
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'invalid_token' })
      return
    }
    next(err)
  }
})

export default router
