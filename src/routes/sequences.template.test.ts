import type { AddressInfo } from 'net'
import type { Server } from 'http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const SEQUENCE_ID = '11111111-1111-4111-8111-111111111111'
const STEP_ID = '22222222-2222-4222-8222-222222222222'

/** Records writes and answers every query with a matching row. */
const db = vi.hoisted(() => {
  const writes: { table: string; op: string; values: Record<string, unknown> }[] = []
  const from = (table: string) => {
    let row: Record<string, unknown> = { id: 'row' }
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      update: (values: Record<string, unknown>) => {
        writes.push({ table, op: 'update', values })
        row = { id: 'row', ...values }
        return builder
      },
      insert: (values: Record<string, unknown>) => {
        writes.push({ table, op: 'insert', values })
        row = { id: 'row', ...values }
        return builder
      },
      single: async () => ({ data: row, error: null }),
    }
    return builder
  }
  return { writes, from }
})

vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: db.from, storage: {} } }))
vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { company_id: 'company' }
    next()
  },
}))

let server: Server
let base: string

beforeAll(async () => {
  const { default: router } = await import('./sequences')
  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use('/sequences', router)
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve)
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sequences/${SEQUENCE_ID}`
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  db.writes.length = 0
})

function upload(name: string, content: string | Buffer) {
  const form = new FormData()
  form.append('file', new Blob([content]), name)
  return fetch(`${base}/template`, { method: 'POST', body: form })
}

function sendJson(method: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const EML = [
  'From: a@example.com',
  'Subject: Test',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><head><title>Acme Ltd</title></head><body style="margin:0"><img style="display:none" src="https://t.test/open"><p style="color:red">Hello</p><script>alert(1)</script></body></html>',
].join('\r\n')

describe('POST /sequences/:id/template', () => {
  it('stores a sanitized template from an EML file and reports what it removed', async () => {
    const res = await upload('offer.eml', EML)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.template_file_name).toBe('offer.eml')
    expect(body.template_html).toContain('<p style="color:red">Hello</p>')
    expect(body.template_html).not.toMatch(/Acme|script|t\.test/)
    expect(body.warnings.removedTrackingPixels).toBe(1)
  })

  it('accepts HTML files', async () => {
    const res = await upload('offer.html', '<p>Hello</p>')
    expect(res.status).toBe(200)
  })

  it('rejects other file types without saving', async () => {
    const res = await upload('offer.pdf', 'x')
    expect(res.status).toBe(400)
    expect(db.writes).toHaveLength(0)
  })

  it('rejects files over the upload limit', async () => {
    const res = await upload('offer.html', Buffer.alloc(4 * 1024 * 1024 + 1, 'a'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('4 MB')
  })

  it('rejects templates too large to send, without saving', async () => {
    const res = await upload('offer.html', `<p>${'x'.repeat(95 * 1024)}</p>`)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Gmail')
    expect(db.writes).toHaveLength(0)
  })
})

describe('PATCH /sequences/:id template_html', () => {
  it('sanitizes the edited template', async () => {
    const res = await sendJson('PATCH', '', {
      template_html: '<body><p>{{company_name}}</p><script>alert(1)</script></body>',
    })
    expect(res.status).toBe(200)
    const saved = db.writes[0].values.template_html as string
    expect(saved).toContain('{{company_name}}')
    expect(saved).not.toContain('script')
  })

  it('accepts a template at the size limit, with JSON escaping overhead', async () => {
    const line = '<p style="color:red">x</p>\n'
    const html = line.repeat(Math.floor((85 * 1024) / line.length))
    const res = await sendJson('PATCH', '', { template_html: html })
    expect(res.status).toBe(200)
  })
})

describe('DELETE /sequences/:id/template', () => {
  it('clears the template', async () => {
    const res = await fetch(`${base}/template`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(db.writes[0].values).toEqual({ template_html: null, template_file_name: null })
  })
})

describe('sequence steps with a styled template', () => {
  const step = { step_order: 1, subject: 'Hi', delay_days: 0 }

  it('creates a styled step without a body, deriving one for the NOT NULL column', async () => {
    const res = await sendJson('POST', '/steps', {
      ...step,
      use_template: true,
      styled_html: '<body><p>Hello {{first_name}}</p></body>',
    })
    expect(res.status).toBe(201)
    const { values } = db.writes[0]
    expect(values.use_template).toBe(true)
    expect(values.styled_html).toContain('Hello {{first_name}}')
    expect(values.body).toBe('<p>Hello {{first_name}}</p>')
  })

  it('keeps a plain body supplied with a styled step', async () => {
    await sendJson('POST', '/steps', {
      ...step,
      body: '<p>Plain</p>',
      use_template: true,
      styled_html: '<p>Styled</p>',
    })
    expect(db.writes[0].values.body).toBe('<p>Plain</p>')
  })

  it('still creates plain steps as before', async () => {
    const res = await sendJson('POST', '/steps', { ...step, body: '<p>Plain</p>' })
    expect(res.status).toBe(201)
    expect(db.writes[0].values.use_template).toBe(false)
    expect(db.writes[0].values.styled_html).toBeUndefined()
  })

  it('requires a body for plain steps', async () => {
    const res = await sendJson('POST', '/steps', step)
    expect(res.status).toBe(400)
  })

  it('requires styled_html when enabling the template', async () => {
    const created = await sendJson('POST', '/steps', { ...step, use_template: true })
    expect(created.status).toBe(400)
    const patched = await sendJson('PATCH', `/steps/${STEP_ID}`, { use_template: true })
    expect(patched.status).toBe(400)
  })

  it('sanitizes styled_html on update', async () => {
    const res = await sendJson('PATCH', `/steps/${STEP_ID}`, {
      use_template: true,
      styled_html: '<p onclick="alert(1)">Hello</p>',
    })
    expect(res.status).toBe(200)
    const update = db.writes.find((w) => w.table === 'sequence_steps')!
    expect(update.values.styled_html).toContain('<p>Hello</p>')
  })

  it('keeps the styled copy when turning the template off', async () => {
    await sendJson('PATCH', `/steps/${STEP_ID}`, { use_template: false, body: '<p>Plain</p>' })
    const update = db.writes.find((w) => w.table === 'sequence_steps')!
    expect(update.values).toEqual({ use_template: false, body: '<p>Plain</p>' })
  })
})
