import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Answers each table from `tables`; a table in `failing` returns a query error. */
const db = vi.hoisted(() => {
  const tables: Record<string, unknown> = {}
  const failing = new Set<string>()
  const from = (table: string) => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      order: () => builder,
      then: (resolve: (value: unknown) => unknown) =>
        resolve(
          failing.has(table)
            ? { data: null, error: { message: 'boom' } }
            : { data: tables[table] ?? null, error: null }
        ),
    }
    return builder
  }
  return { tables, failing, from }
})

const enqueueJobs = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: db.from } }))
vi.mock('../queues/dbEmailQueue', () => ({ enqueueJobs }))

import { triggerNextSequenceStep } from './triggerNextSequenceStep'

const STEP = { id: 'step-1', step_order: 1, delay_days: 0 }
// Wednesday 22:00 in Sofia: outside the 09:00-17:00 working window
const AFTER_HOURS = new Date('2026-11-04T20:00:00Z')
// Thursday 09:00 in Sofia
const NEXT_WINDOW = new Date('2026-11-05T07:00:00Z')

function trigger({ force = false, isWarmup = false } = {}) {
  return triggerNextSequenceStep('campaign', false, ['sequence'], ['mb'], force, isWarmup)
}

function jobDelays(): number[] {
  const calls = enqueueJobs.mock.calls as unknown as [{ opts: { delay: number } }[]][]
  return calls[0][0].map((job) => job.opts.delay)
}

beforeEach(() => {
  for (const key of Object.keys(db.tables)) delete db.tables[key]
  db.failing.clear()
  enqueueJobs.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(AFTER_HOURS)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('when nothing can be enqueued', () => {
  it('reports no_active_leads', async () => {
    db.tables.leads = []
    db.tables.sequence_steps = [STEP]
    expect(await trigger()).toMatchObject({ enqueued: 0, reason: 'no_active_leads' })
  })

  it('reports no_steps for active leads on a sequence without steps', async () => {
    db.tables.leads = [{ id: 'a' }, { id: 'b' }]
    db.tables.sequence_steps = []
    expect(await trigger()).toMatchObject({ enqueued: 0, reason: 'no_steps' })
    expect(enqueueJobs).not.toHaveBeenCalled()
  })

  it('reports sequence_complete when every lead received the last step', async () => {
    db.tables.leads = [{ id: 'a' }]
    db.tables.sequence_steps = [STEP]
    db.tables.email_logs = [{ lead_id: 'a', step_id: STEP.id, sent_at: AFTER_HOURS.toISOString() }]
    expect(await trigger()).toMatchObject({ enqueued: 0, reason: 'sequence_complete' })
  })
})

describe('query errors', () => {
  it.each(['leads', 'sequence_steps', 'email_logs'])('throws when %s cannot be read', async (table) => {
    db.tables.leads = [{ id: 'a' }]
    db.tables.sequence_steps = [STEP]
    db.failing.add(table)
    await expect(trigger()).rejects.toThrow('boom')
    expect(enqueueJobs).not.toHaveBeenCalled()
  })
})

describe('scheduling', () => {
  beforeEach(() => {
    db.tables.leads = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    db.tables.sequence_steps = [STEP]
    db.tables.mailboxes = [
      { id: 'mb', warmup_started_at: AFTER_HOURS.toISOString(), daily_email_limit: 20 },
    ]
  })

  it('sends normal campaigns immediately', async () => {
    const result = await trigger()
    expect(jobDelays()).toEqual([0, 0, 0])
    expect(result).toEqual({ needs_confirmation: false, enqueued: 3, affected_leads: 3 })
  })

  it('holds warmup campaigns for the working window, with gaps between sends', async () => {
    const result = await trigger({ isWarmup: true })
    const [first, second, third] = jobDelays()
    expect(first).toBeGreaterThanOrEqual(NEXT_WINDOW.getTime() - AFTER_HOURS.getTime())
    expect(second - first).toBeGreaterThanOrEqual(3 * 60 * 1000)
    expect(third - second).toBeGreaterThanOrEqual(3 * 60 * 1000)
    expect(result).toMatchObject({
      enqueued: 3,
      first_send_at: new Date(AFTER_HOURS.getTime() + first).toISOString(),
    })
  })

  it('keeps warmup timing even when forced', async () => {
    await trigger({ isWarmup: true, force: true })
    expect(jobDelays()[0]).toBeGreaterThanOrEqual(NEXT_WINDOW.getTime() - AFTER_HOURS.getTime())
  })

  it('rolls warmup sends to the next day past the daily limit', async () => {
    db.tables.mailboxes = [
      { id: 'mb', warmup_started_at: AFTER_HOURS.toISOString(), daily_email_limit: 2 },
    ]
    await trigger({ isWarmup: true })
    const [, second, third] = jobDelays()
    expect(third - second).toBeGreaterThan(12 * 60 * 60 * 1000)
  })
})
