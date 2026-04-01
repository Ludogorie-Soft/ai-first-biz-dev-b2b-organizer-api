/**
 * Email warmup and deliverability scheduling.
 *
 * Daily limit ramp per inbox:
 *   Day  0–6:  8 / day
 *   Day  7–20: 12 / day
 *   Day 21+:   18 / day
 *   Hard cap:  25 / day (v1)
 *
 * Scheduling: Option B — each email is its own event with a random
 * timestamp inside the working window (09:00–17:00 Sofia time) and a
 * minimum 3–8 minute gap from the previous one.
 *
 * Timezone: Europe/Sofia (UTC+2 EET / UTC+3 EEST — DST-aware via Intl).
 */

const TIMEZONE       = 'Europe/Sofia'
const WORK_START_HOUR = 9
const WORK_END_HOUR   = 17
const MIN_GAP_MINUTES = 3
const MAX_GAP_MINUTES = 8
const HARD_CAP        = 25

export const HARD_BOUNCE_THRESHOLD = 0.05  // 5%

// ── Timezone helpers ──────────────────────────────────────────────────────

/**
 * Returns the UTC offset of Europe/Sofia at a given instant, in milliseconds.
 * Handles DST automatically (UTC+2 in winter, UTC+3 in summer).
 */
function getSofiaOffsetMs(date: Date): number {
  const utcStr   = date.toLocaleString('en-US', { timeZone: 'UTC' })
  const sofiaStr = date.toLocaleString('en-US', { timeZone: TIMEZONE })
  return new Date(sofiaStr).getTime() - new Date(utcStr).getTime()
}

/**
 * Returns a UTC Date representing HH:00:00 in Sofia local time
 * on the same Sofia calendar day as `date`.
 *
 * Example: sofiaHourAsUtc(someDate, 9) on a summer day (UTC+3)
 *          → returns the UTC Date for 06:00 UTC (= 09:00 Sofia)
 */
function sofiaHourAsUtc(date: Date, hour: number): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)

  const y = parseInt(parts.find((p) => p.type === 'year')!.value)
  const m = parseInt(parts.find((p) => p.type === 'month')!.value) - 1
  const d = parseInt(parts.find((p) => p.type === 'day')!.value)

  // First treat the wall-clock Sofia time as if it were UTC
  const wallClock = new Date(Date.UTC(y, m, d, hour, 0, 0, 0))
  // Then subtract the Sofia offset to get the true UTC instant
  const offsetMs  = getSofiaOffsetMs(wallClock)
  return new Date(wallClock.getTime() - offsetMs)
}

/** Returns the current hour (0–23) in Sofia local time for a given Date. */
function sofiaHour(date: Date): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      hour12: false,
    }).format(date),
    10
  )
}

/**
 * Returns the earliest valid send slot at or after `from`,
 * respecting the 09:00–17:00 Sofia working window.
 * Adds a random 0–20 min initial offset so campaigns don't all start at exactly 09:00.
 */
function nextWorkingSlot(from: Date): Date {
  const hour = sofiaHour(from)

  if (hour < WORK_START_HOUR) {
    const windowStart = sofiaHourAsUtc(from, WORK_START_HOUR)
    return new Date(windowStart.getTime() + Math.random() * 20 * 60 * 1000)
  }

  if (hour >= WORK_END_HOUR) {
    // After 17:00 Sofia — move to next calendar day
    const tomorrow = new Date(from)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    const windowStart = sofiaHourAsUtc(tomorrow, WORK_START_HOUR)
    return new Date(windowStart.getTime() + Math.random() * 20 * 60 * 1000)
  }

  // Already inside working hours — start from now with a small buffer
  return new Date(from.getTime() + 2 * 60 * 1000)
}

function randomGapMs(): number {
  const minutes = MIN_GAP_MINUTES + Math.random() * (MAX_GAP_MINUTES - MIN_GAP_MINUTES)
  return minutes * 60 * 1000
}

// ── Public API ────────────────────────────────────────────────────────────

export function getDailyLimit(warmupStartedAt: Date | null): number {
  if (!warmupStartedAt) return 8
  const daysSince = Math.floor(
    (Date.now() - warmupStartedAt.getTime()) / (1000 * 60 * 60 * 24)
  )
  if (daysSince >= 21) return Math.min(18, HARD_CAP)
  if (daysSince >= 7)  return Math.min(12, HARD_CAP)
  return Math.min(8, HARD_CAP)
}

/**
 * Computes an array of `count` scheduled send times for a single mailbox.
 * All times land inside 09:00–17:00 Europe/Sofia with 3–8 min random gaps.
 * Rolls over to the next working day when the daily limit or end-of-window is reached.
 */
export function computeScheduledTimes(
  count: number,
  dailyLimit: number,
  from: Date
): Date[] {
  const times: Date[] = []
  let cursor = nextWorkingSlot(from)
  let emailsScheduledToday = 0

  for (let i = 0; i < count; i++) {
    const dayEnd = sofiaHourAsUtc(cursor, WORK_END_HOUR)

    if (emailsScheduledToday >= dailyLimit || cursor >= dayEnd) {
      // Roll to next working day at 09:00 Sofia + random offset
      const nextDay = new Date(cursor)
      nextDay.setUTCDate(nextDay.getUTCDate() + 1)
      const windowStart = sofiaHourAsUtc(nextDay, WORK_START_HOUR)
      cursor = new Date(windowStart.getTime() + Math.random() * 20 * 60 * 1000)
      emailsScheduledToday = 0
    }

    times.push(new Date(cursor))
    emailsScheduledToday++
    cursor = new Date(cursor.getTime() + randomGapMs())
  }

  return times
}

/**
 * Given a `delay_days` value for a follow-up step, returns the delay in
 * milliseconds that lands at a random time inside 09:00–17:00 Sofia time
 * on the target day.
 */
export function delayMsForNextStep(delayDays: number): number {
  const targetDay   = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000)
  const workStart   = sofiaHourAsUtc(targetDay, WORK_START_HOUR)
  const workEnd     = sofiaHourAsUtc(targetDay, WORK_END_HOUR)
  const windowMs    = workEnd.getTime() - workStart.getTime()
  const randomOffset = Math.random() * windowMs
  return workStart.getTime() + randomOffset - Date.now()
}
