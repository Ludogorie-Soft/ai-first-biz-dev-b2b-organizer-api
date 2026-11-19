import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Tiny in-memory stand-in for the two tables claimJobs touches.
 * Supports the filters claimJobs uses: eq, lte, in, order, limit, update, select.
 */
const db = vi.hoisted(() => {
  type Row = Record<string, unknown>
  const tables: Record<string, Row[]> = { campaigns: [], mailboxes: [], email_queue: [] }

  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let patch: Row | null = null
    let orderBy: string | null = null
    let max: number | null = null

    const run = () => {
      let rows = tables[table].filter((r) => filters.every((f) => f(r)))
      if (orderBy) rows = [...rows].sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!])))
      if (max !== null) rows = rows.slice(0, max)
      if (patch) rows.forEach((r) => Object.assign(r, patch))
      return { data: rows.map((r) => ({ ...r })), error: null }
    }

    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (p: Row) => ((patch = p), builder),
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), builder),
      lte: (col: string, v: string) => (filters.push((r) => String(r[col]) <= v), builder),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), builder),
      // Only the form claimJobs uses: not(col, 'in', '(a,b)')
      not: (col: string, _op: string, list: string) => {
        const vs = list.replace(/^\(|\)$/g, '').split(',')
        filters.push((r) => !vs.includes(String(r[col])))
        return builder
      },
      order: (col: string) => ((orderBy = col), builder),
      limit: (n: number) => ((max = n), builder),
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    }
    return builder
  }
  return { tables, from }
})

vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: db.from } }))

import { claimJobs } from './dbEmailQueue'

const PAST = '2026-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

function job(id: string, campaign_id: string, extra: Record<string, unknown> = {}) {
  return { id, campaign_id, status: 'pending', scheduled_at: PAST, ...extra }
}

beforeEach(() => {
  db.tables.campaigns = [
    { id: 'active', status: 'active' },
    { id: 'paused', status: 'paused' },
    { id: 'done', status: 'completed' },
  ]
  db.tables.mailboxes = [
    { id: 'mb-ok', is_paused: false },
    { id: 'mb-paused', is_paused: true },
  ]
  db.tables.email_queue = []
})

describe('claimJobs', () => {
  it('claims only due, pending jobs of active campaigns', async () => {
    db.tables.email_queue = [
      job('a1', 'active'),
      job('p1', 'paused'),
      job('c1', 'done'),
      job('d1', 'deleted-campaign'),
      job('f1', 'active', { scheduled_at: FUTURE }),
      job('s1', 'active', { status: 'sent' }),
    ]

    const claimed = await claimJobs(5)

    expect(claimed.map((j) => j.id)).toEqual(['a1'])
    const byId = Object.fromEntries(db.tables.email_queue.map((r) => [r.id, r.status]))
    expect(byId).toMatchObject({ a1: 'processing', p1: 'pending', c1: 'pending', d1: 'pending', f1: 'pending' })
  })

  it('is not starved by many earlier jobs of a paused campaign', async () => {
    db.tables.email_queue = [
      ...Array.from({ length: 20 }, (_, i) =>
        job(`p${i}`, 'paused', { scheduled_at: `2025-01-01T00:00:${String(i).padStart(2, '0')}.000Z` })
      ),
      job('a1', 'active'),
    ]

    const claimed = await claimJobs(5)

    expect(claimed.map((j) => j.id)).toEqual(['a1'])
  })

  it('respects the batch size and oldest-first order', async () => {
    db.tables.email_queue = [
      job('late', 'active', { scheduled_at: '2026-01-03T00:00:00.000Z' }),
      job('early', 'active', { scheduled_at: '2026-01-01T00:00:00.000Z' }),
      job('mid', 'active', { scheduled_at: '2026-01-02T00:00:00.000Z' }),
    ]

    const claimed = await claimJobs(2)

    expect(claimed.map((j) => j.id).sort()).toEqual(['early', 'mid'])
  })

  it('holds jobs of a paused mailbox as pending and still claims other mailboxes', async () => {
    db.tables.email_queue = [
      job('held', 'active', { mailbox_id: 'mb-paused', scheduled_at: '2026-01-01T00:00:00.000Z' }),
      job('ok', 'active', { mailbox_id: 'mb-ok', scheduled_at: '2026-01-02T00:00:00.000Z' }),
    ]

    const claimed = await claimJobs(5)

    expect(claimed.map((j) => j.id)).toEqual(['ok'])
    expect(db.tables.email_queue.find((r) => r.id === 'held')?.status).toBe('pending')

    // Unpausing the mailbox releases the held job
    db.tables.mailboxes[1].is_paused = false
    expect((await claimJobs(5)).map((j) => j.id)).toEqual(['held'])
  })

  it('returns nothing when there are no active campaigns', async () => {
    db.tables.campaigns = [{ id: 'paused', status: 'paused' }]
    db.tables.email_queue = [job('p1', 'paused')]

    expect(await claimJobs(5)).toEqual([])
    expect(db.tables.email_queue[0].status).toBe('pending')
  })
})
