import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

/** In-memory tables supporting the calls resumeMailbox makes. */
const db = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {}
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let patch: Row | null = null
    const run = () => {
      const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (patch) hit.forEach((r) => Object.assign(r, patch))
      return hit.map((r) => ({ ...r }))
    }
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (p: Row) => ((patch = p), builder),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), builder),
      order: () => builder,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: run(), error: null }),
    }
    return builder
  }
  return { tables, from }
})

vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: db.from } }))

import { resumeMailbox } from './mailboxPause'

const HOUR = 3600 * 1000
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

beforeEach(() => {
  db.tables.mailboxes = [
    {
      id: 'mb-1',
      is_paused: true,
      paused_reason: 'high_bounce_rate',
      paused_at: iso(-48 * HOUR),
      paused_bounce_rate: 0.181,
      paused_bounced_count: 21,
      paused_total_count: 116,
      bounce_check_since: null,
      warmup_started_at: iso(-60 * 24 * HOUR),
      daily_email_limit: 18,
    },
  ]
  db.tables.email_queue = [
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `overdue-${i}`,
      mailbox_id: 'mb-1',
      status: 'pending',
      send_on_weekends: false,
      scheduled_at: iso(-24 * HOUR + i * 60_000),
    })),
    { id: 'future', mailbox_id: 'mb-1', status: 'pending', send_on_weekends: false, scheduled_at: iso(10 * 24 * HOUR) },
    { id: 'other-mailbox', mailbox_id: 'mb-2', status: 'pending', send_on_weekends: false, scheduled_at: iso(-HOUR) },
  ]
})

describe('resumeMailbox', () => {
  it('clears the pause and starts counting bounces from now', async () => {
    const before = Date.now()
    await resumeMailbox('mb-1')
    const mb = db.tables.mailboxes[0]
    expect(mb).toMatchObject({
      is_paused: false,
      paused_reason: null,
      paused_at: null,
      paused_bounce_rate: null,
      paused_bounced_count: null,
      paused_total_count: null,
    })
    expect(new Date(mb.bounce_check_since as string).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('spreads overdue emails over the send window instead of sending them at once', async () => {
    const result = await resumeMailbox('mb-1')
    expect(result).toEqual({ rescheduled_jobs: 30 })

    const overdue = db.tables.email_queue
      .filter((j) => String(j.id).startsWith('overdue'))
      .map((j) => new Date(j.scheduled_at as string).getTime())
    expect(overdue.every((t) => t >= Date.now() - 1000)).toBe(true)
    // Daily limit 18: 30 emails need more than one day
    const days = new Set(overdue.map((t) => new Date(t).toISOString().slice(0, 10)))
    expect(days.size).toBeGreaterThan(1)
    // At least 3 minutes between consecutive sends
    const sorted = [...overdue].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(3 * 60_000)
  })

  it('keeps later emails and other mailboxes untouched', async () => {
    const future = db.tables.email_queue.find((j) => j.id === 'future')!.scheduled_at
    const other = db.tables.email_queue.find((j) => j.id === 'other-mailbox')!.scheduled_at
    await resumeMailbox('mb-1')
    expect(db.tables.email_queue.find((j) => j.id === 'future')!.scheduled_at).toBe(future)
    expect(db.tables.email_queue.find((j) => j.id === 'other-mailbox')!.scheduled_at).toBe(other)
  })

  it('returns null for an unknown mailbox', async () => {
    expect(await resumeMailbox('missing')).toBeNull()
  })
})
