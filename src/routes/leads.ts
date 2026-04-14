import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import XLSX from 'xlsx'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'
import { enqueueCampaignJobs } from '../utils/enqueueCampaignJobs'
import { ensureUnsubscribeTokens } from '../utils/unsubscribeTokens'

const router = Router()
router.use(authMiddleware)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

interface ColumnMap {
  email: string | null
  first_name: string | null
  last_name: string | null
  company_name: string | null
  position: string | null
  notes: string | null
}

/**
 * @swagger
 * /leads/template:
 *   get:
 *     summary: Download an Excel template with sample data for lead import
 *     tags: [Leads]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Excel file (.xlsx)
 */
router.get('/template', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const sample = [
      {
        'First Name': 'John',
        'Last Name': 'Doe',
        'Job Title': 'CEO',
        'Email': 'john.doe@acme.com',
        'Linkedin URL': 'https://linkedin.com/in/johndoe',
        'Facebook URL': 'https://facebook.com/johndoe',
        'Company': 'Acme Corp',
        'Website': 'https://acme.com',
        'Office Email': 'office@acme.com',
        'Telephone': '+1 555 000 0000',
        'Company Linkedin': 'https://linkedin.com/company/acme',
        'Size': '51-200',
        'Industry': 'Software',
        'Location': 'Sofia, Bulgaria',
      },
    ]
    const ws = XLSX.utils.json_to_sheet(sample)

    // Bold headers + fit column width to header text
    const headers = Object.keys(sample[0])
    headers.forEach((header, i) => {
      const cellRef = XLSX.utils.encode_cell({ r: 0, c: i })
      if (ws[cellRef]) ws[cellRef].s = { font: { bold: true } }
    })
    ws['!cols'] = headers.map((h) => ({ wch: h.length + 4 }))

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Leads')
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true })
    res.setHeader('Content-Disposition', 'attachment; filename="leads_template.xlsx"')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.send(buffer)
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /leads:
 *   get:
 *     summary: List leads (optionally filtered by campaign)
 *     tags: [Leads]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: campaign_id
 *         schema: { type: string }
 *         description: Filter by campaign UUID
 *     responses:
 *       200:
 *         description: Array of lead objects
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50))
    const from = (page - 1) * limit
    let query = supabaseAdmin
      .from('leads')
      .select('*', { count: 'exact' })
      .eq('company_id', req.user.company_id)
      .order('created_at')
      .range(from, from + limit - 1)
    if (req.query.campaign_id) {
      query = query.eq('campaign_id', req.query.campaign_id as string)
    }
    const { data, error, count } = await query
    if (error) {
      res.status(400).json({ error: error.message })
      return
    }
    res.json({ data, total: count, page, limit })
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /leads/{id}:
 *   patch:
 *     summary: Update a lead's status or notes
 *     tags: [Leads]
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
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [active, replied, unsubscribed, bounced, opted_out]
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: Updated lead
 *       404:
 *         description: Lead not found
 */
router.patch('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid lead ID' })
    return
  }
  try {
    const schema = z
      .object({
        status: z.enum(['active', 'replied', 'unsubscribed', 'bounced', 'opted_out']).optional(),
        notes: z.string().optional(),
      })
      .refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' })
    const body = schema.parse(req.body)

    const { data, error } = await supabaseAdmin
      .from('leads')
      .update(body)
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .select()
      .single()
    if (error || !data) {
      res.status(404).json({ error: 'Lead not found' })
      return
    }

    // When manually re-activating a lead, remove them from the suppression list
    // so future imports of the same email are not auto-suppressed.
    if (body.status === 'active') {
      await supabaseAdmin
        .from('suppressed_emails')
        .delete()
        .eq('company_id', req.user.company_id)
        .eq('email', (data as { email: string }).email)
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
 * /leads/preview:
 *   post:
 *     summary: Parse an Excel file and return its column headers (for mapping UI)
 *     tags: [Leads]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Column headers and first 3 rows as preview
 */
router.post(
  '/preview',
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Excel file is required' })
        return
      }
      const ALLOWED_MIMETYPES = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
      ]
      if (!ALLOWED_MIMETYPES.includes(req.file.mimetype)) {
        res.status(400).json({ error: 'Only .xlsx and .xls files are accepted' })
        return
      }

      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })

      if (rows.length === 0) {
        res.status(400).json({ error: 'Excel file is empty' })
        return
      }

      res.json({
        columns: Object.keys(rows[0]),
        preview: rows.slice(0, 3),
        total_rows: rows.length,
      })
    } catch (err) {
      next(err)
    }
  }
)

/**
 * @swagger
 * /leads/import:
 *   post:
 *     summary: Import leads from Excel file into a campaign
 *     tags: [Leads]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, campaign_id]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               campaign_id:
 *                 type: string
 *                 description: UUID of the campaign
 *               column_map:
 *                 type: string
 *                 description: 'JSON string mapping field names to Excel column headers, e.g. {"email":"Email Address","first_name":"First Name","last_name":"Last Name","notes":"Notes"}'
 *     responses:
 *       201:
 *         description: Leads imported successfully
 *       400:
 *         description: Validation error or invalid file
 */
router.post(
  '/import',
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { campaign_id, column_map: rawColMap } = req.body as {
        campaign_id?: string
        column_map?: string
      }
      if (!campaign_id) {
        res.status(400).json({ error: 'campaign_id is required' })
        return
      }
      if (!req.file) {
        res.status(400).json({ error: 'Excel file is required' })
        return
      }

      const ALLOWED_MIMETYPES = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
        'application/vnd.ms-excel', // .xls
      ]
      if (!ALLOWED_MIMETYPES.includes(req.file.mimetype)) {
        res.status(400).json({ error: 'Only .xlsx and .xls files are accepted' })
        return
      }

      // Verify campaign belongs to company and get its status + linked sequences/mailboxes
      const { data: campaign, error: campErr } = await supabaseAdmin
        .from('campaigns')
        .select('id, status, campaign_sequences(sequence_id), campaign_mailboxes(mailbox_id)')
        .eq('id', campaign_id)
        .eq('company_id', req.user.company_id)
        .single()
      if (campErr || !campaign) {
        res.status(404).json({ error: 'Campaign not found' })
        return
      }

      // Parse Excel
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })

      if (rows.length === 0) {
        res.status(400).json({ error: 'Excel file is empty' })
        return
      }

      // Column mapping: explicit map or auto-detect
      let colMap: ColumnMap = { email: null, first_name: null, last_name: null, company_name: null, position: null, notes: null }
      const hasColMap = rawColMap && rawColMap.trim().startsWith('{')
      if (hasColMap) {
        try {
          colMap = JSON.parse(rawColMap) as ColumnMap
        } catch {
          res.status(400).json({ error: 'column_map must be a valid JSON string, e.g. {"email":"Email Address"}' })
          return
        }
      } else {
        // Auto-detect by common column names (case-insensitive)
        const headers = Object.keys(rows[0])
        const find = (candidates: string[]): string | null =>
          headers.find((h) => candidates.includes(h.toLowerCase().trim())) ?? null
        colMap = {
          email: find(['email', 'e-mail', 'email address']),
          first_name: find(['first_name', 'first name', 'firstname', 'name']),
          last_name: find(['last_name', 'last name', 'lastname', 'surname']),
          company_name: find(['company_name', 'company name', 'company', 'organization', 'organisation']),
          position: find(['position', 'job title', 'title', 'role', 'job_title']),
          notes: find(['notes', 'note', 'comments', 'comment']),
        }
      }

      if (!colMap.email) {
        res.status(400).json({ error: 'Could not map email column. Provide column_map.' })
        return
      }

      const emailCol = colMap.email
      const leadsToInsert = rows
        .map((row) => ({
          company_id: req.user.company_id,
          campaign_id,
          email: String(row[emailCol] ?? '').trim().toLowerCase(),
          first_name: colMap.first_name ? String(row[colMap.first_name] ?? '').trim() || null : null,
          last_name: colMap.last_name ? String(row[colMap.last_name] ?? '').trim() || null : null,
          company_name: colMap.company_name ? String(row[colMap.company_name] ?? '').trim() || null : null,
          position: colMap.position ? String(row[colMap.position] ?? '').trim() || null : null,
          notes: colMap.notes ? String(row[colMap.notes] ?? '').trim() || null : null,
        }))
        .filter((l) => l.email && l.email.includes('@'))

      if (leadsToInsert.length === 0) {
        res.status(400).json({ error: 'No valid leads found in the file' })
        return
      }

      // Upsert to avoid duplicates within the same campaign.
      const { data: insertedLeads, error: insertErr } = await supabaseAdmin
        .from('leads')
        .upsert(leadsToInsert, { onConflict: 'company_id,campaign_id,email', ignoreDuplicates: true })
        .select('id')
      if (insertErr) {
        res.status(400).json({ error: insertErr.message })
        return
      }

      if (insertedLeads && insertedLeads.length > 0) {
        const leadIds = insertedLeads.map((l: { id: string }) => l.id)

        // Generate unsubscribe tokens for all newly inserted leads.
        // Awaited so the token exists before jobs are enqueued and the worker runs.
        try {
          await ensureUnsubscribeTokens(
            leadIds.map((leadId: string) => ({ lead_id: leadId, company_id: req.user.company_id }))
          )
        } catch (err) {
          console.error(
            '[Leads] Failed to create unsubscribe tokens:',
            err instanceof Error ? err.message : err
          )
        }

        // Check suppression list — emails that previously unsubscribed must stay unsubscribed
        // even when re-imported into a new campaign after the old one was deleted.
        const importedEmails = leadsToInsert.map((l) => l.email)
        const { data: suppressed } = await supabaseAdmin
          .from('suppressed_emails')
          .select('email')
          .eq('company_id', req.user.company_id)
          .in('email', importedEmails)

        const suppressedEmails = new Set((suppressed ?? []).map((s: { email: string }) => s.email))

        if (suppressedEmails.size > 0) {
          await supabaseAdmin
            .from('leads')
            .update({ status: 'unsubscribed' })
            .eq('company_id', req.user.company_id)
            .eq('campaign_id', campaign_id)
            .in('email', [...suppressedEmails])
        }

        // Fetch the active lead IDs after suppression so we don't enqueue jobs for suppressed leads.
        // We re-query because insertedLeads only contains { id } with no email field.
        const { data: activeLeads } = await supabaseAdmin
          .from('leads')
          .select('id')
          .eq('company_id', req.user.company_id)
          .eq('campaign_id', campaign_id)
          .eq('status', 'active')
          .in('id', leadIds)

        const activeLeadIds = (activeLeads ?? []).map((l: { id: string }) => l.id)

        // If campaign is active, enqueue step-1 jobs for non-suppressed leads only
        if (campaign.status === 'active' && activeLeadIds.length > 0) {
          await enqueueCampaignJobs(campaign_id, activeLeadIds).catch((e: Error) =>
            console.error('[Leads] Failed to enqueue jobs after import:', e.message)
          )
        }
      }

      res.status(201).json({ imported: leadsToInsert.length, message: `${leadsToInsert.length} leads processed` })
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: err.errors })
        return
      }
      next(err)
    }
  }
)

export default router
