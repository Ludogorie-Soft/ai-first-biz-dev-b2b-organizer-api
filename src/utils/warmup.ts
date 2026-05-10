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

/** Weekday in Sofia: 0 = Sunday … 6 = Saturday */
function sofiaWeekday(date: Date): number {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
  }).format(date)
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  return map[short] ?? 0
}

/**
 * If `from` falls on Saturday or Sunday in Sofia, advance to the next Monday
 * at 09:00 Sofia + random 0–20 min. Otherwise returns a copy of `from`.
 */
export function skipWeekend(from: Date): Date {
  let t = from.getTime()
  let d = new Date(t)
  let wd = sofiaWeekday(d)
  if (wd >= 1 && wd <= 5) {
    return new Date(t)
  }
  for (let i = 0; i < 7; i++) {
    t += 24 * 60 * 60 * 1000
    d = new Date(t)
    wd = sofiaWeekday(d)
    if (wd >= 1 && wd <= 5) {
      const windowStart = sofiaHourAsUtc(d, WORK_START_HOUR)
      return new Date(windowStart.getTime() + Math.random() * 20 * 60 * 1000)
    }
  }
  return new Date(from.getTime())
}

/**
 * Milliseconds from `from` until the next calendar day's 09:00 Sofia window
 * (with jitter). When `sendOnWeekends` is false, the chosen slot skips weekends.
 */
export function msUntilNextDaySendWindow(
  sendOnWeekends: boolean,
  from: Date = new Date()
): number {
  const nextDay = new Date(from)
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  let slot = new Date(
    sofiaHourAsUtc(nextDay, WORK_START_HOUR).getTime() + Math.random() * 20 * 60 * 1000
  )
  if (!sendOnWeekends) {
    slot = skipWeekend(slot)
  }
  return Math.max(0, slot.getTime() - Date.now())
}

/**
 * Returns the earliest valid send slot at or after `from`,
 * respecting the 09:00–17:00 Sofia working window.
 * When `sendOnWeekends` is false, never lands on Saturday/Sunday in Sofia.
 * Adds a random 0–20 min initial offset so campaigns don't all start at exactly 09:00.
 */
function nextWorkingSlot(from: Date, sendOnWeekends: boolean): Date {
  let anchor = new Date(from.getTime())
  if (!sendOnWeekends) {
    anchor = skipWeekend(anchor)
  }

  const hour = sofiaHour(anchor)

  if (hour < WORK_START_HOUR) {
    let slot = new Date(
      sofiaHourAsUtc(anchor, WORK_START_HOUR).getTime() + Math.random() * 20 * 60 * 1000
    )
    if (!sendOnWeekends) slot = skipWeekend(slot)
    return slot
  }

  if (hour >= WORK_END_HOUR) {
    const tomorrow = new Date(anchor)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    let slot = new Date(
      sofiaHourAsUtc(tomorrow, WORK_START_HOUR).getTime() + Math.random() * 20 * 60 * 1000
    )
    if (!sendOnWeekends) slot = skipWeekend(slot)
    return slot
  }

  // Already inside working hours — start from now with a small buffer
  return new Date(anchor.getTime() + 2 * 60 * 1000)
}

function randomGapMs(): number {
  const minutes = MIN_GAP_MINUTES + Math.random() * (MAX_GAP_MINUTES - MIN_GAP_MINUTES)
  return minutes * 60 * 1000
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Returns the effective daily send limit for a mailbox given its warmup start date
 * and its configured maximum limit (admin-set target, defaults to HARD_CAP).
 *
 * The warmup ramp always applies:
 *   Days  0–6:  min(8,  maxLimit)
 *   Days  7–20: min(12, maxLimit)
 *   Days 21+:   maxLimit  (fully warmed up)
 *
 * Existing callers that omit maxLimit continue to use HARD_CAP as the ceiling.
 */
export function getDailyLimit(warmupStartedAt: Date | null, maxLimit = HARD_CAP): number {
  if (!warmupStartedAt) return Math.min(8, maxLimit)
  const daysSince = Math.floor(
    (Date.now() - warmupStartedAt.getTime()) / (1000 * 60 * 60 * 24)
  )
  if (daysSince >= 21) return maxLimit
  if (daysSince >= 7)  return Math.min(12, maxLimit)
  return Math.min(8, maxLimit)
}

/**
 * Computes an array of `count` scheduled send times for a single mailbox.
 * All times land inside 09:00–17:00 Europe/Sofia with 3–8 min random gaps.
 * Rolls over to the next day when the daily limit or end-of-window is reached.
 * When `sendOnWeekends` is false, rollovers skip Saturday and Sunday.
 */
export function computeScheduledTimes(
  count: number,
  dailyLimit: number,
  from: Date,
  sendOnWeekends = false
): Date[] {
  const times: Date[] = []
  let cursor = nextWorkingSlot(from, sendOnWeekends)
  let emailsScheduledToday = 0

  for (let i = 0; i < count; i++) {
    const dayEnd = sofiaHourAsUtc(cursor, WORK_END_HOUR)

    if (emailsScheduledToday >= dailyLimit || cursor >= dayEnd) {
      const nextDay = new Date(cursor)
      nextDay.setUTCDate(nextDay.getUTCDate() + 1)
      const windowStart = sofiaHourAsUtc(nextDay, WORK_START_HOUR)
      cursor = new Date(windowStart.getTime() + Math.random() * 20 * 60 * 1000)
      if (!sendOnWeekends) {
        cursor = skipWeekend(cursor)
      }
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
 * on the target day. When `sendOnWeekends` is false, the target day is adjusted
 * off Saturday/Sunday.
 */
export function delayMsForNextStep(delayDays: number, sendOnWeekends = false): number {
  let anchor = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000)
  if (!sendOnWeekends) {
    anchor = skipWeekend(anchor)
  }
  const workStart   = sofiaHourAsUtc(anchor, WORK_START_HOUR)
  const workEnd     = sofiaHourAsUtc(anchor, WORK_END_HOUR)
  const windowMs    = workEnd.getTime() - workStart.getTime()
  const randomOffset = Math.random() * windowMs
  return workStart.getTime() + randomOffset - Date.now()
}
