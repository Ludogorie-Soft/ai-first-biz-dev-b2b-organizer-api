import { describe, it, expect } from 'vitest'
import { getDailyLimit, getWarmupStatus, warmedUpStartDate, WARMUP_DAYS } from './warmup'

const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-11-16T12:00:00Z')

describe('getWarmupStatus', () => {
  it('reports a new mailbox as warming up, ending WARMUP_DAYS after start', () => {
    const start = new Date(now.getTime() - 6 * DAY)
    const s = getWarmupStatus(start.toISOString(), 50, now)
    expect(s.is_warming_up).toBe(true)
    expect(s.warmup_ends_at).toBe(new Date(start.getTime() + WARMUP_DAYS * DAY).toISOString())
  })

  it('reports a mailbox past WARMUP_DAYS as warmed up with no end date', () => {
    const s = getWarmupStatus(new Date(now.getTime() - 30 * DAY), 50, now)
    expect(s.is_warming_up).toBe(false)
    expect(s.warmup_ends_at).toBeNull()
  })

  it('treats a mailbox as warming up even when its configured limit is below the ramp', () => {
    const s = getWarmupStatus(new Date(now.getTime() - 2 * DAY), 5, now)
    expect(s.is_warming_up).toBe(true)
    expect(s.effective_daily_limit).toBe(5)
  })
})

describe('warmedUpStartDate', () => {
  it('yields a start date at which the configured limit applies in full', () => {
    expect(getDailyLimit(warmedUpStartDate(), 50)).toBe(50)
    expect(getWarmupStatus(warmedUpStartDate(now), 50, now).is_warming_up).toBe(false)
  })
})
