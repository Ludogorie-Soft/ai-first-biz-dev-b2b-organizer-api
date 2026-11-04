import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Answers each table from `tables` and records updates. */
const db = vi.hoisted(() => {
  const tables: Record<string, unknown> = {}
  const updates: { table: string; values: Record<string, unknown> }[] = []
  const from = (table: string) => {
    const result = () => {
      const data = tables[table] ?? null
      return { data, error: null, count: Array.isArray(data) ? data.length : 0 }
    }
    const first = async () => {
      const { data } = result()
      return { data: Array.isArray(data) ? data[0] ?? null : data, error: null }
    }
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      update: (values: Record<string, unknown>) => {
        updates.push({ table, values })
        return builder
      },
      single: first,
      maybeSingle: first,
      then: (resolve: (value: unknown) => unknown) => resolve(result()),
    }
    return builder
  }
  return { tables, updates, from }
})

const enqueueJobs = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: db.from } }))
vi.mock('../queues/dbEmailQueue', () => ({ enqueueJobs }))

import { checkAndCompleteCampaign } from './campaignCompletion'
import { enqueueCampaignJobs } from './enqueueCampaignJobs'
import { findMailboxesPendingFriendlyWarmup, isHeldForFriendlyWarmup } from './friendlyWarmup'

beforeEach(() => {
  for (const key of Object.keys(db.tables)) delete db.tables[key]
  db.updates.length = 0
  enqueueJobs.mockClear()
})

describe('isHeldForFriendlyWarmup', () => {
  it('holds normal campaigns', async () => {
    db.tables.campaigns = { is_warmup: false }
    expect(await isHeldForFriendlyWarmup('campaign')).toBe(true)
  })

  it('lets warmup campaigns send', async () => {
    db.tables.campaigns = { is_warmup: true }
    expect(await isHeldForFriendlyWarmup('campaign')).toBe(false)
  })
})

describe('findMailboxesPendingFriendlyWarmup', () => {
  it('skips the query when there are no mailboxes', async () => {
    db.tables.mailboxes = [{ email: 'should-not-be-read@example.com' }]
    expect(await findMailboxesPendingFriendlyWarmup([])).toEqual([])
  })

  it('returns the mailbox emails', async () => {
    db.tables.mailboxes = [{ email: 'new@example.com' }]
    expect(await findMailboxesPendingFriendlyWarmup(['mb'])).toEqual(['new@example.com'])
  })
})

describe('enqueueCampaignJobs with a first step that has delay_days = 0', () => {
  function setUp(isWarmup: boolean) {
    db.tables.campaigns = {
      id: 'campaign',
      send_on_weekends: false,
      is_warmup: isWarmup,
      campaign_sequences: [{ sequence_id: 'sequence' }],
      campaign_mailboxes: [{ mailbox_id: 'mb' }],
    }
    db.tables.mailboxes = [
      { id: 'mb', warmup_started_at: new Date().toISOString(), is_paused: false, daily_email_limit: 20 },
    ]
    db.tables.sequence_steps = { id: 'step', delay_days: 0 }
  }

  function delays(): number[] {
    const calls = enqueueJobs.mock.calls as unknown as [{ opts: { delay: number } }[]][]
    return calls[0][0].map((job) => job.opts.delay)
  }

  it('sends normal campaigns immediately', async () => {
    setUp(false)
    await enqueueCampaignJobs('campaign', ['a', 'b', 'c'])
    expect(delays()).toEqual([0, 0, 0])
  })

  it('spaces warmup campaigns at least 3 minutes apart', async () => {
    setUp(true)
    await enqueueCampaignJobs('campaign', ['a', 'b', 'c'])
    const [first, second, third] = delays()
    // Slightly under 3 minutes: each delay is measured against its own Date.now()
    const minGapMs = 3 * 60 * 1000 - 5000
    expect(second - first).toBeGreaterThanOrEqual(minGapMs)
    expect(third - second).toBeGreaterThanOrEqual(minGapMs)
  })
})

describe('checkAndCompleteCampaign', () => {
  function setUp(isWarmup: boolean) {
    db.tables.campaigns = { status: 'active', is_warmup: isWarmup }
    db.tables.campaign_sequences = { sequence_id: 'sequence' }
    db.tables.sequence_steps = [{ id: 'step' }]
    db.tables.leads = [{ id: 'lead', status: 'replied' }]
    db.tables.email_logs = []
    db.tables.campaign_mailboxes = [{ mailbox_id: 'mb' }]
  }

  it('releases the mailboxes of a completed warmup campaign', async () => {
    setUp(true)
    await checkAndCompleteCampaign('campaign')
    expect(db.updates).toContainEqual({ table: 'campaigns', values: { status: 'completed' } })
    expect(db.updates).toContainEqual({ table: 'mailboxes', values: { friendly_warmup_pending: false } })
  })

  it('does not release mailboxes when a normal campaign completes', async () => {
    setUp(false)
    await checkAndCompleteCampaign('campaign')
    expect(db.updates).toContainEqual({ table: 'campaigns', values: { status: 'completed' } })
    expect(db.updates.some((u) => u.table === 'mailboxes')).toBe(false)
  })

  it('keeps the mailbox held while a friendly contact still has emails to come', async () => {
    setUp(true)
    db.tables.leads = [{ id: 'lead', status: 'active' }]
    await checkAndCompleteCampaign('campaign')
    expect(db.updates).toEqual([])
  })
})
