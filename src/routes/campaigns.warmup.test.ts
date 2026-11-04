import type { AddressInfo } from 'net'
import type { Server } from 'http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111'
const MAILBOX_ID = '22222222-2222-4222-8222-222222222222'
const GROUP_ID = '33333333-3333-4333-8333-333333333333'
const SEQUENCE_ID = '44444444-4444-4444-8444-444444444444'

const db = vi.hoisted(() => {
  const tables: Record<string, unknown> = {}
  const writes: { table: string; op: string; values: unknown }[] = []
  const from = (table: string) => {
    let written: unknown
    const result = () => ({ data: written ?? tables[table] ?? null, error: null })
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      update: (values: unknown) => {
        writes.push({ table, op: 'update', values })
        written = { ...(tables[table] as object), ...(values as object) }
        return builder
      },
      insert: (values: unknown) => {
        writes.push({ table, op: 'insert', values })
        written = { id: 'new', ...(values as object) }
        return builder
      },
      single: async () => {
        const { data } = result()
        return { data: Array.isArray(data) ? data[0] ?? null : data, error: null }
      },
      then: (resolve: (value: unknown) => unknown) => resolve(result()),
    }
    return builder
  }
  return { tables, writes, from }
})

vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: db.from } }))
vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { company_id: 'company', role: 'owner' }
    next()
  },
}))

let server: Server
let base: string

beforeAll(async () => {
  const { default: router } = await import('./campaigns')
  const app = express()
  app.use(express.json())
  app.use('/campaigns', router)
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve)
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/campaigns`
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  for (const key of Object.keys(db.tables)) delete db.tables[key]
  db.writes.length = 0
})

function send(method: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const newCampaign = {
  name: 'Campaign',
  target_group_id: GROUP_ID,
  sequence_ids: [SEQUENCE_ID],
  mailbox_ids: [MAILBOX_ID],
}

const pendingMailbox = {
  id: MAILBOX_ID,
  email: 'new@example.com',
  ses_status: 'active',
  friendly_warmup_pending: true,
}

describe('POST /campaigns', () => {
  it('rejects a normal campaign on a mailbox awaiting friendly warmup', async () => {
    db.tables.mailboxes = [pendingMailbox]
    const res = await send('POST', '', newCampaign)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: 'FRIENDLY_WARMUP_PENDING',
      mailboxes: ['new@example.com'],
    })
    expect(db.writes).toEqual([])
  })

  it('allows a warmup campaign on that mailbox', async () => {
    db.tables.mailboxes = [pendingMailbox]
    const res = await send('POST', '', { ...newCampaign, is_warmup: true })
    expect(res.status).toBe(201)
    expect((await res.json()).is_warmup).toBe(true)
  })

  it('allows a normal campaign once the mailbox is released', async () => {
    db.tables.mailboxes = [{ ...pendingMailbox, friendly_warmup_pending: false }]
    const res = await send('POST', '', newCampaign)
    expect(res.status).toBe(201)
  })

  it('rejects a sequence that has no steps without creating anything', async () => {
    db.tables.mailboxes = [{ ...pendingMailbox, friendly_warmup_pending: false }]
    db.tables.sequences = [{ name: 'Empty', sequence_steps: [] }]
    const res = await send('POST', '', newCampaign)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'SEQUENCE_HAS_NO_STEPS', sequences: ['Empty'] })
    expect(db.writes).toEqual([])
  })

  it('allows a sequence that has steps', async () => {
    db.tables.mailboxes = [{ ...pendingMailbox, friendly_warmup_pending: false }]
    db.tables.sequences = [{ name: 'Ready', sequence_steps: [{ id: 'step' }] }]
    const res = await send('POST', '', newCampaign)
    expect(res.status).toBe(201)
  })
})

describe('PATCH /campaigns/:id', () => {
  it('rejects activating a normal campaign on a mailbox awaiting friendly warmup', async () => {
    db.tables.campaigns = {
      status: 'paused',
      is_warmup: false,
      campaign_mailboxes: [{ mailbox_id: MAILBOX_ID }],
    }
    db.tables.mailboxes = [pendingMailbox]
    const res = await send('PATCH', `/${CAMPAIGN_ID}`, { status: 'active' })
    expect(res.status).toBe(409)
    expect(db.writes).toEqual([])
  })

  it('rejects activating a campaign whose sequence has no steps', async () => {
    db.tables.campaigns = {
      status: 'paused',
      is_warmup: false,
      campaign_mailboxes: [],
      campaign_sequences: [{ sequence_id: SEQUENCE_ID }],
    }
    db.tables.sequences = [{ name: 'Empty', sequence_steps: [] }]
    const res = await send('PATCH', `/${CAMPAIGN_ID}`, { status: 'active' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'SEQUENCE_HAS_NO_STEPS', sequences: ['Empty'] })
    expect(db.writes).toEqual([])
  })

  it('still allows pausing a campaign whose sequence has no steps', async () => {
    db.tables.campaigns = { status: 'active', is_warmup: false }
    db.tables.sequences = [{ name: 'Empty', sequence_steps: [] }]
    const res = await send('PATCH', `/${CAMPAIGN_ID}`, { status: 'paused' })
    expect(res.status).toBe(200)
  })

  it('releases the mailboxes when a warmup campaign is completed by hand', async () => {
    db.tables.campaigns = { status: 'active', is_warmup: true }
    db.tables.campaign_mailboxes = [{ mailbox_id: MAILBOX_ID }]
    const res = await send('PATCH', `/${CAMPAIGN_ID}`, { status: 'completed' })
    expect(res.status).toBe(200)
    expect(db.writes).toContainEqual({
      table: 'mailboxes',
      op: 'update',
      values: { friendly_warmup_pending: false },
    })
  })

  it('does not release mailboxes when a warmup campaign is only paused', async () => {
    db.tables.campaigns = { status: 'active', is_warmup: true }
    const res = await send('PATCH', `/${CAMPAIGN_ID}`, { status: 'paused' })
    expect(res.status).toBe(200)
    expect(db.writes.some((w) => w.table === 'mailboxes')).toBe(false)
  })
})
