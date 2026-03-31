import { ReplyCategory } from '../types'

const POSITIVE: string[] = [
  'interested',
  'yes',
  'sure',
  'sounds good',
  "let's talk",
  'schedule',
  'demo',
  'call me',
  'more info',
  'tell me more',
  'when can',
  'available',
  'book a',
]

const NEGATIVE: string[] = [
  'not interested',
  'no thanks',
  'unsubscribe',
  'remove me',
  "don't contact",
  'do not contact',
  'stop emailing',
  'leave me alone',
  'stop bothering',
]

const OOO: string[] = [
  'out of office',
  'on vacation',
  'away from office',
  'will be back',
  'auto-reply',
  'automatic reply',
  'currently out',
]

function categorizeReply(body: string): ReplyCategory {
  const lower = (body || '').toLowerCase()
  if (OOO.some((kw) => lower.includes(kw))) return 'out_of_office'
  if (NEGATIVE.some((kw) => lower.includes(kw))) return 'negative'
  if (POSITIVE.some((kw) => lower.includes(kw))) return 'positive'
  return 'neutral'
}

export { categorizeReply }
