import { beforeEach, describe, expect, it, vi } from 'vitest'

type Filter = [op: string, column: string, value: unknown]
interface Call {
  table: string
  update?: Record<string, unknown>
  filters: Filter[]
}

/**
 * Records every query; `respond` decides the rows each one returns.
 * Rows are matched against the eq/neq/in filters, so tests describe the
 * database state and the filters are what is being checked.
 */
const db = vi.hoisted(() => {
  const calls: Call[] = []
  const rows: Record<string, Record<string, unknown>[]> = {}

  const matches = (row: Record<string, unknown>, filters: Filter[]) =>
    filters.every(([op, col, val]) =>
      op === 'eq' ? row[col] === val : op === 'neq' ? row[col] !== val : op === 'in' ? (val as unknown[]).includes(row[col]) : true
    )

  const from = (table: string) => {
    const call: Call = { table, filters: [] }
    calls.push(call)
    const run = () => {
      const hit = (rows[table] ?? []).filter((r) => matches(r, call.filters))
      if (call.update) for (const r of hit) Object.assign(r, call.update)
      return hit.map((r) => ({ ...r }))
    }
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (values: Record<string, unknown>) => ((call.update = values), builder),
      eq: (c: string, v: unknown) => (call.filters.push(['eq', c, v]), builder),
      neq: (c: string, v: unknown) => (call.filters.push(['neq', c, v]), builder),
      in: (c: string, v: unknown) => (call.filters.push(['in', c, v]), builder),
      gte: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: run(), error: null }),
    }
    return builder
  }
  return { calls, rows, from }
})

vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: db.from } }))

import { recordHardBounce } from './hardBounce'

function seed() {
  db.calls.length = 0
  db.rows.leads = [
    { id: 'lead-a', company_id: 'co-1', campaign_id: 'camp-1', email: 'bad@client.bg', office_email: null, status: 'active' },
    { id: 'lead-b', company_id: 'co-1', campaign_id: 'camp-1', email: 'ok@client.bg', office_email: 'office-bad@client.bg', status: 'active' },
    { id: 'lead-c', company_id: 'co-2', campaign_id: 'camp-2', email: 'bad@client.bg', office_email: null, status: 'active' },
  ]
  db.rows.email_logs = [
    { id: 'log-a', lead_id: 'lead-a', mailbox_id: 'mb-1', status: 'sent', recipient_email: 'bad@client.bg' },
    { id: 'log-b1', lead_id: 'lead-b', mailbox_id: 'mb-1', status: 'sent', recipient_email: 'ok@client.bg' },
    { id: 'log-b2', lead_id: 'lead-b', mailbox_id: 'mb-1', status: 'sent', recipient_email: 'office-bad@client.bg' },
  ]
  db.rows.mailboxes = [{ id: 'mb-1', is_paused: false }]
}

const lead = (id: string) => db.rows.leads.find((l) => l.id === id)!
const log = (id: string) => db.rows.email_logs.find((l) => l.id === id)!

describe('recordHardBounce', () => {
  beforeEach(seed)

  it('marks a lead bounced when its primary email bounces, only within the given company', async () => {
    const result = await recordHardBounce('Bad@Client.bg', { companyId: 'co-1' })

    expect(result).toEqual({ bouncedLeadIds: ['lead-a'], clearedOfficeLeadIds: [], campaignIds: ['camp-1'] })
    expect(lead('lead-a').status).toBe('bounced')
    expect(log('log-a').status).toBe('bounced')
    expect(lead('lead-c').status).toBe('active')
  })

  it('applies to every company without companyId (SES webhook)', async () => {
    const result = await recordHardBounce('bad@client.bg')
    expect(result.bouncedLeadIds.sort()).toEqual(['lead-a', 'lead-c'])
  })

  it('clears only the office email when it bounces, keeping the lead active', async () => {
    const result = await recordHardBounce('office-bad@client.bg', { companyId: 'co-1' })

    expect(result).toEqual({ bouncedLeadIds: [], clearedOfficeLeadIds: ['lead-b'], campaignIds: ['camp-1'] })
    expect(lead('lead-b')).toMatchObject({ status: 'active', office_email: null })
    expect(log('log-b2').status).toBe('bounced')
    expect(log('log-b1').status).toBe('sent')
  })

  it('changes nothing when the same bounce is processed again', async () => {
    await recordHardBounce('bad@client.bg', { companyId: 'co-1' })
    await recordHardBounce('office-bad@client.bg', { companyId: 'co-1' })
    const before = JSON.stringify(db.rows)

    const again = await recordHardBounce('bad@client.bg', { companyId: 'co-1' })
    const againOffice = await recordHardBounce('office-bad@client.bg', { companyId: 'co-1' })

    expect(again.bouncedLeadIds).toEqual([])
    expect(againOffice.clearedOfficeLeadIds).toEqual([])
    expect(JSON.stringify(db.rows)).toBe(before)
  })

  it('falls back to the latest sent log for logs written before recipient_email existed', async () => {
    log('log-a').recipient_email = null
    await recordHardBounce('bad@client.bg', { companyId: 'co-1' })
    expect(log('log-a').status).toBe('bounced')
  })
})
