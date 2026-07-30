import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import { z, ZodError } from 'zod'
import { supabaseAdmin } from '../config/supabase'
import { authMiddleware } from '../middleware/auth'
import { sanitizeEmailBody } from '../utils/emailHtml'
import {
  ATTACHMENT_BUCKET,
  MAX_ATTACHMENTS_PER_STEP,
  MAX_ATTACHMENT_BYTES,
  buildStoragePath,
  deleteStoragePaths,
  isAllowedAttachment,
  resolveContentType,
  sanitizeFileName,
} from '../utils/attachments'

const router = Router()
router.use(authMiddleware)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
})

const STEPS_WITH_ATTACHMENTS = '*, sequence_steps(*, sequence_step_attachments(*))'

/**
 * @swagger
 * /sequences:
 *   get:
 *     summary: List sequences with their steps
 *     tags: [Sequences]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Array of sequence objects with nested steps
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('sequences')
      .select(STEPS_WITH_ATTACHMENTS)
      .eq('company_id', req.user.company_id)
      .order('created_at')
      .order('step_order', { referencedTable: 'sequence_steps' })
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
 * /sequences:
 *   post:
 *     summary: Create a new sequence
 *     tags: [Sequences]
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
 *         description: Sequence created
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schema = z.object({ name: z.string().min(1) })
    const body = schema.parse(req.body)
    const { data, error } = await supabaseAdmin
      .from('sequences')
      .insert({ name: body.name, company_id: req.user.company_id })
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
 * /sequences/{id}/steps:
 *   post:
 *     summary: Add a step to a sequence
 *     tags: [Sequences]
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
 *             required: [step_order, subject, body]
 *             properties:
 *               step_order: { type: integer }
 *               subject: { type: string }
 *               body: { type: string }
 *               delay_days: { type: integer, default: 0 }
 *     responses:
 *       201:
 *         description: Step created
 *       404:
 *         description: Sequence not found
 */
router.post('/:id/steps', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schema = z.object({
      step_order: z.number().int().positive(),
      subject: z.string().min(1),
      body: z.string().min(1),
      delay_days: z.number().int().min(0).default(0),
    })
    const parsed = schema.parse(req.body)
    const body = { ...parsed, body: sanitizeEmailBody(parsed.body) }
    if (!body.body) {
      res.status(400).json({ error: 'Body is required' })
      return
    }

    // Verify sequence belongs to company
    const { data: seq, error: seqErr } = await supabaseAdmin
      .from('sequences')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .single()
    if (seqErr || !seq) {
      res.status(404).json({ error: 'Sequence not found' })
      return
    }

    const { data, error } = await supabaseAdmin
      .from('sequence_steps')
      .insert({ sequence_id: req.params.id, ...body })
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
 * /sequences/{id}:
 *   get:
 *     summary: Get a single sequence with its steps
 *     tags: [Sequences]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sequence object with steps
 *       404:
 *         description: Not found
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid sequence ID' })
    return
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('sequences')
      .select(STEPS_WITH_ATTACHMENTS)
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .order('step_order', { referencedTable: 'sequence_steps' })
      .single()
    if (error || !data) {
      res.status(404).json({ error: 'Sequence not found' })
      return
    }
    res.json(data)
  } catch (err) {
    next(err)
  }
})

/**
 * @swagger
 * /sequences/{id}:
 *   patch:
 *     summary: Update a sequence
 *     tags: [Sequences]
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
 *               name: { type: string }
 *               include_signature: { type: boolean }
 *     responses:
 *       200:
 *         description: Updated sequence
 *       404:
 *         description: Not found
 */
router.patch('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid sequence ID' })
    return
  }
  try {
    const schema = z
      .object({
        name: z.string().min(1).optional(),
        include_signature: z.boolean().optional(),
      })
      .refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' })
    const body = schema.parse(req.body)

    const { data, error } = await supabaseAdmin
      .from('sequences')
      .update(body)
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .select()
      .single()
    if (error || !data) {
      res.status(404).json({ error: 'Sequence not found' })
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
 * /sequences/{id}:
 *   delete:
 *     summary: Delete a sequence and all its steps
 *     tags: [Sequences]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid sequence ID' })
    return
  }
  try {
    const { data: seq } = await supabaseAdmin
      .from('sequences')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .single()
    if (!seq) {
      res.status(404).json({ error: 'Sequence not found' })
      return
    }

    const { data: steps } = await supabaseAdmin
      .from('sequence_steps')
      .select('id, sequence_step_attachments(storage_path)')
      .eq('sequence_id', req.params.id)

    const paths: string[] = []
    for (const step of steps || []) {
      const attachments = (step as { sequence_step_attachments?: { storage_path: string }[] })
        .sequence_step_attachments || []
      for (const a of attachments) paths.push(a.storage_path)
    }
    await deleteStoragePaths(paths)

    const { error } = await supabaseAdmin
      .from('sequences')
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

/**
 * @swagger
 * /sequences/{id}/steps/{stepId}:
 *   patch:
 *     summary: Update a sequence step
 *     tags: [Sequences]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               subject: { type: string }
 *               body: { type: string }
 *               delay_days: { type: integer }
 *               step_order: { type: integer }
 *     responses:
 *       200:
 *         description: Updated step
 *       404:
 *         description: Step not found
 */
router.patch('/:id/steps/:stepId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success ||
      !z.string().uuid().safeParse(req.params.stepId).success) {
    res.status(400).json({ error: 'Invalid ID' })
    return
  }
  try {
    const schema = z
      .object({
        subject: z.string().min(1).optional(),
        body: z.string().min(1).optional(),
        delay_days: z.number().int().min(0).optional(),
        step_order: z.number().int().positive().optional(),
      })
      .refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' })
    const parsed = schema.parse(req.body)
    const body =
      parsed.body !== undefined
        ? { ...parsed, body: sanitizeEmailBody(parsed.body) }
        : parsed
    if (parsed.body !== undefined && !body.body) {
      res.status(400).json({ error: 'Body is required' })
      return
    }

    // Verify sequence belongs to company before touching its steps
    const { data: seq } = await supabaseAdmin
      .from('sequences')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .single()
    if (!seq) {
      res.status(404).json({ error: 'Sequence not found' })
      return
    }

    const { data, error } = await supabaseAdmin
      .from('sequence_steps')
      .update(body)
      .eq('id', req.params.stepId)
      .eq('sequence_id', req.params.id)
      .select()
      .single()
    if (error || !data) {
      res.status(404).json({ error: 'Step not found' })
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
 * /sequences/{id}/steps/{stepId}/attachments:
 *   post:
 *     summary: Upload an attachment for a sequence step
 *     tags: [Sequences]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: Attachment created
 *       400:
 *         description: Validation error
 *       404:
 *         description: Step not found
 */
router.post(
  '/:id/steps/:stepId/attachments',
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'File exceeds 4 MB limit' })
        return
      }
      if (err) {
        next(err)
        return
      }
      next()
    })
  },
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!z.string().uuid().safeParse(req.params.id).success ||
        !z.string().uuid().safeParse(req.params.stepId).success) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }
    try {
      const file = req.file
      if (!file) {
        res.status(400).json({ error: 'File is required' })
        return
      }

      const validationError = isAllowedAttachment(file.originalname, file.mimetype, file.size)
      if (validationError) {
        res.status(400).json({ error: validationError })
        return
      }

      const sequenceId = String(req.params.id)
      const stepId = String(req.params.stepId)

      const contentType = resolveContentType(file.originalname, file.mimetype)!
      const fileName = sanitizeFileName(file.originalname)

      const { data: seq } = await supabaseAdmin
        .from('sequences')
        .select('id')
        .eq('id', sequenceId)
        .eq('company_id', req.user.company_id)
        .single()
      if (!seq) {
        res.status(404).json({ error: 'Sequence not found' })
        return
      }

      const { data: step } = await supabaseAdmin
        .from('sequence_steps')
        .select('id')
        .eq('id', stepId)
        .eq('sequence_id', sequenceId)
        .single()
      if (!step) {
        res.status(404).json({ error: 'Step not found' })
        return
      }

      const { count } = await supabaseAdmin
        .from('sequence_step_attachments')
        .select('id', { count: 'exact', head: true })
        .eq('step_id', stepId)
      if ((count ?? 0) >= MAX_ATTACHMENTS_PER_STEP) {
        res.status(400).json({ error: `Maximum ${MAX_ATTACHMENTS_PER_STEP} attachments per step` })
        return
      }

      const storagePath = buildStoragePath(
        req.user.company_id,
        sequenceId,
        stepId,
        fileName
      )

      const { error: uploadError } = await supabaseAdmin.storage
        .from(ATTACHMENT_BUCKET)
        .upload(storagePath, file.buffer, {
          contentType,
          upsert: false,
        })
      if (uploadError) {
        res.status(400).json({ error: uploadError.message })
        return
      }

      const { data, error } = await supabaseAdmin
        .from('sequence_step_attachments')
        .insert({
          step_id: stepId,
          file_name: fileName,
          content_type: contentType,
          size_bytes: file.size,
          storage_path: storagePath,
        })
        .select()
        .single()
      if (error) {
        await deleteStoragePaths([storagePath])
        res.status(400).json({ error: error.message })
        return
      }
      res.status(201).json(data)
    } catch (err) {
      next(err)
    }
  }
)

/**
 * @swagger
 * /sequences/{id}/steps/{stepId}/attachments/{attachmentId}:
 *   delete:
 *     summary: Delete a sequence step attachment
 *     tags: [Sequences]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: attachmentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
router.delete(
  '/:id/steps/:stepId/attachments/:attachmentId',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!z.string().uuid().safeParse(req.params.id).success ||
        !z.string().uuid().safeParse(req.params.stepId).success ||
        !z.string().uuid().safeParse(req.params.attachmentId).success) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }
    try {
      const { data: seq } = await supabaseAdmin
        .from('sequences')
        .select('id')
        .eq('id', req.params.id)
        .eq('company_id', req.user.company_id)
        .single()
      if (!seq) {
        res.status(404).json({ error: 'Sequence not found' })
        return
      }

      const { data: step } = await supabaseAdmin
        .from('sequence_steps')
        .select('id')
        .eq('id', req.params.stepId)
        .eq('sequence_id', req.params.id)
        .single()
      if (!step) {
        res.status(404).json({ error: 'Step not found' })
        return
      }

      const { data: attachment } = await supabaseAdmin
        .from('sequence_step_attachments')
        .select('*')
        .eq('id', req.params.attachmentId)
        .eq('step_id', req.params.stepId)
        .single()
      if (!attachment) {
        res.status(404).json({ error: 'Attachment not found' })
        return
      }

      await deleteStoragePaths([(attachment as { storage_path: string }).storage_path])

      const { error } = await supabaseAdmin
        .from('sequence_step_attachments')
        .delete()
        .eq('id', req.params.attachmentId)
        .eq('step_id', req.params.stepId)
      if (error) {
        res.status(400).json({ error: error.message })
        return
      }
      res.status(204).send()
    } catch (err) {
      next(err)
    }
  }
)

/**
 * @swagger
 * /sequences/{id}/steps/{stepId}:
 *   delete:
 *     summary: Delete a sequence step
 *     tags: [Sequences]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
router.delete('/:id/steps/:stepId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!z.string().uuid().safeParse(req.params.id).success ||
      !z.string().uuid().safeParse(req.params.stepId).success) {
    res.status(400).json({ error: 'Invalid ID' })
    return
  }
  try {
    const { data: seq } = await supabaseAdmin
      .from('sequences')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .single()
    if (!seq) {
      res.status(404).json({ error: 'Sequence not found' })
      return
    }

    const { data: attachments } = await supabaseAdmin
      .from('sequence_step_attachments')
      .select('storage_path')
      .eq('step_id', req.params.stepId)
    await deleteStoragePaths((attachments || []).map((a) => (a as { storage_path: string }).storage_path))

    const { error } = await supabaseAdmin
      .from('sequence_steps')
      .delete()
      .eq('id', req.params.stepId)
      .eq('sequence_id', req.params.id)
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
