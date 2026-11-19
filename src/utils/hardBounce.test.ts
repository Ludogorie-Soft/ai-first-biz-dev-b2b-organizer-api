import { beforeEach, describe, expect, it, vi } from 'vitest'

type Filter = [op: string, column: string, value: unknown]
interface Call {
  table: string
  update?: Record<string, unknown>
  delete?: boolean
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
      op === 'eq' ? row[col] === val
        : op === 'neq' ? row[col] !== val
        : op === 'in' ? (val as unknown[]).includes(row[col])
        : op === 'gte' ? String(row[col]) >= String(val)
        : true
    )

  const from = (table: string) => {
    const call: Call = { table, filters: [] }
    calls.push(call)
    const run = () => {
      const hit = (rows[table] ?? []).filter((r) => matches(r, call.filters))
      if (call.update) for (const r of hit) Object.assign(r, call.update)
      if (call.delete) rows[table] = (rows[table] ?? []).filter((r) => !hit.includes(r))
      return hit.map((r) => ({ ...r }))
    }
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (values: Record<string, unknown>) => ((call.update = values), builder),
      delete: () => ((call.delete = true), builder),
      eq: (c: string, v: unknown) => (call.filters.push(['eq', c, v]), builder),
      neq: (c: string, v: unknown) => (call.filters.push(['neq', c, v]), builder),
      in: (c: string, v: unknown) => (call.filters.push(['in', c, v]), builder),
      gte: (c: string, v: unknown) => (call.filters.push(['gte', c, v]), builder),
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

import { checkAndPauseIfNeeded, recordHardBounce } from './hardBounce'

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
  db.rows.email_queue = [
    { id: 'job-a', lead_id: 'lead-a', status: 'pending' },
    { id: 'job-a-busy', lead_id: 'lead-a', status: 'processing' },
    { id: 'job-b', lead_id: 'lead-b', status: 'pending' },
    { id: 'job-c', lead_id: 'lead-c', status: 'pending' },
  ]
}

const jobIds = () => db.rows.email_queue.map((j) => j.id)

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
    // Pending emails of the bounced lead are dropped; one being sent right now is left to the sender
    expect(jobIds()).toEqual(['job-a-busy', 'job-b', 'job-c'])
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
    // The lead keeps getting the sequence at its primary address
    expect(jobIds()).toContain('job-b')
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

describe('checkAndPauseIfNeeded', () => {
  const recent = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const logs = (sent: number, bounced: number, created_at = recent) => [
    ...Array.from({ length: sent }, (_, i) => ({ id: `s${i}`, mailbox_id: 'mb-1', status: 'sent', created_at })),
    ...Array.from({ length: bounced }, (_, i) => ({ id: `b${i}`, mailbox_id: 'mb-1', status: 'bounced', created_at })),
  ]
  const mailbox = () => db.rows.mailboxes[0]

  beforeEach(() => {
    db.rows.mailboxes = [{ id: 'mb-1', is_paused: false, bounce_check_since: null }]
  })

  it('pauses above 5% and records the reason and numbers', async () => {
    db.rows.email_logs = logs(18, 2) // 10%
    await checkAndPauseIfNeeded('mb-1')
    expect(mailbox()).toMatchObject({
      is_paused: true,
      paused_reason: 'high_bounce_rate',
      paused_bounce_rate: 0.1,
      paused_bounced_count: 2,
      paused_total_count: 20,
    })
    expect(mailbox().paused_at).toEqual(expect.any(String))
  })

  it('does not pause at or below 5%, or with fewer than 10 emails', async () => {
    db.rows.email_logs = logs(19, 1) // 5%
    await checkAndPauseIfNeeded('mb-1')
    db.rows.email_logs = logs(5, 4)
    await checkAndPauseIfNeeded('mb-1')
    expect(mailbox().is_paused).toBe(false)
  })

  it('after a resume, ignores the bounces from before it', async () => {
    db.rows.email_logs = logs(95, 21, new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString())
    mailbox().bounce_check_since = new Date(Date.now() - 36 * 3600 * 1000).toISOString()
    await checkAndPauseIfNeeded('mb-1')
    expect(mailbox().is_paused).toBe(false)

    // New bounces after the resume still count
    db.rows.email_logs.push(...logs(8, 2))
    await checkAndPauseIfNeeded('mb-1')
    expect(mailbox()).toMatchObject({ is_paused: true, paused_bounced_count: 2, paused_total_count: 10 })
  })
})
