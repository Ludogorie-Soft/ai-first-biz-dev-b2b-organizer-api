import type { ParsedMail } from 'mailparser'

/**
 * Recognises bounce messages ("address not found", "user unknown", ...) that
 * arrive in a mailbox's inbox, sent by the recipient's mail server
 * (mailer-daemon / postmaster) after it first accepted the email.
 *
 * SES never sees these as bounces, so they do not reach /webhooks/ses.
 */
export interface BounceInfo {
  /** True when at least one recipient failed permanently (5.x.x): the address is invalid. */
  permanent: boolean
  /**
   * Addresses the bounce reports as failed, lowercase. When permanent is true,
   * only the permanently failed ones. Empty when the bounce names no recipient
   * in a machine-readable way; see mentionedAddresses.
   */
  recipients: string[]
  /**
   * Every address found in the bounce text and the returned original message,
   * lowercase. Only for bounces without machine-readable recipients: the caller
   * matches these against its own leads.
   */
  mentionedAddresses: string[]
}

const DSN_CONTENT_TYPES = ['message/delivery-status', 'message/global-delivery-status']

const BOUNCE_SENDER = /^(mailer-?daemon|postmaster|mail-?delivery(-?subsystem)?|mail-?daemon)$/i

const BOUNCE_SUBJECT = new RegExp(
  [
    'undeliverable',
    'undelivered mail',
    'delivery status notification \\(failure\\)',
    'delivery (has )?failed',
    'delivery failure',
    'failure notice',
    'returned mail',
    'mail delivery failed',
    'could not be delivered',
    'non-?delivery',
    'message not delivered',
    'недоставен',
    'не може да бъде доставен',
    'не беше доставен',
  ].join('|'),
  'i'
)

/** Phrases that mean the address itself is invalid. */
const HARD_PHRASES = [
  'user unknown',
  'unknown user',
  'no such user',
  'no such recipient',
  'unknown recipient',
  'invalid recipient',
  'invalid address',
  'invalid mailbox',
  'recipient not found',
  'address not found',
  'mailbox not found',
  'mailbox unavailable',
  'mailbox does not exist',
  'does not exist',
  "doesn't exist",
  "couldn't be found",
  'could not be found',
  "wasn't found",
  'recipient address rejected',
  'address rejected',
  'no mailbox here',
  'account has been disabled',
  'account is disabled',
  'no longer exists',
  'not a valid',
  'is not valid',
  // Bulgarian
  'не съществува',
  'невалиден адрес',
  'невалиден имейл',
  'невалиден получател',
  'непознат получател',
  'непознат потребител',
]

/** Phrases that mean a temporary problem: the address may still be valid. */
const SOFT_PHRASES = [
  'mailbox full',
  'mailbox is full',
  'over quota',
  'quota exceeded',
  'insufficient storage',
  'will retry',
  'will continue to try',
  'temporarily',
  'delayed',
  'препълнена',
]

const HARD_STATUS = /\b5\.\d{1,3}\.\d{1,3}\b/
const HARD_SMTP_CODE = /\b55[0-4]\b/
const SOFT_STATUS = /\b4\.\d{1,3}\.\d{1,3}\b/

const EMAIL = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

interface DsnRecipient {
  address: string
  action: string
  status: string
  diagnostic: string
}

function headerText(mail: ParsedMail, name: string): string {
  const value = mail.headers?.get(name)
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text
  if (typeof value === 'object' && 'value' in value && typeof value.value === 'string') return value.value
  return String(value)
}

function isDeliveryReport(mail: ParsedMail): boolean {
  const ct = mail.headers?.get('content-type') as
    | { value?: string; params?: Record<string, string> }
    | string
    | undefined
  if (!ct || typeof ct === 'string') return false
  return (
    ct.value?.toLowerCase() === 'multipart/report' &&
    /delivery-status/i.test(ct.params?.['report-type'] ?? '')
  )
}

function attachmentText(mail: ParsedMail, contentTypes: string[]): string {
  return (mail.attachments ?? [])
    .filter((a) => contentTypes.includes(a.contentType?.toLowerCase()))
    .map((a) => a.content?.toString('utf8') ?? '')
    .join('\n\n')
}

function bodyText(mail: ParsedMail): string {
  if (typeof mail.text === 'string' && mail.text.trim()) return mail.text
  if (typeof mail.html === 'string') return mail.html.replace(/<[^>]*>/g, ' ')
  return ''
}

function stripAddressType(value: string): string {
  // "rfc822; John@Example.com" → "john@example.com"
  const addr = value.includes(';') ? value.slice(value.indexOf(';') + 1) : value
  return addr.trim().replace(/^<|>$/g, '').toLowerCase()
}

/** Parses the per-recipient blocks of a message/delivery-status part (RFC 3464). */
function parseDsn(text: string): DsnRecipient[] {
  const recipients: DsnRecipient[] = []
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ')
  for (const block of unfolded.split(/\n\s*\n/)) {
    const fields = new Map<string, string>()
    for (const line of block.split('\n')) {
      const idx = line.indexOf(':')
      if (idx <= 0) continue
      fields.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim())
    }
    const address = fields.get('final-recipient') ?? fields.get('original-recipient')
    if (!address) continue
    recipients.push({
      address: stripAddressType(address),
      action: (fields.get('action') ?? '').toLowerCase(),
      status: fields.get('status') ?? '',
      diagnostic: fields.get('diagnostic-code') ?? '',
    })
  }
  return recipients
}

function isPermanentDsnRecipient(r: DsnRecipient): boolean {
  if (['delayed', 'delivered', 'relayed', 'expanded'].includes(r.action)) return false
  if (r.status) return r.status.trim().startsWith('5')
  return r.action === 'failed' && HARD_SMTP_CODE.test(r.diagnostic)
}

/** Decides from free text whether a bounce is permanent; used when there is no DSN part. */
function textLooksPermanent(text: string): boolean {
  const lower = text.toLowerCase()
  const hard =
    HARD_STATUS.test(lower) || HARD_SMTP_CODE.test(lower) || HARD_PHRASES.some((p) => lower.includes(p))
  if (hard) return !SOFT_PHRASES.some((p) => lower.includes(p)) || HARD_STATUS.test(lower)
  return false
}

function senderLocalPart(mail: ParsedMail): string {
  const address = mail.from?.value?.[0]?.address ?? ''
  return address.split('@')[0] ?? ''
}

/** Returns bounce details, or null when the message is not a bounce. */
export function detectBounce(mail: ParsedMail): BounceInfo | null {
  const dsnText = attachmentText(mail, DSN_CONTENT_TYPES)
  const failedHeader = headerText(mail, 'x-failed-recipients')
  const subject = mail.subject ?? ''

  const isBounce =
    isDeliveryReport(mail) ||
    dsnText.length > 0 ||
    failedHeader.length > 0 ||
    BOUNCE_SENDER.test(senderLocalPart(mail)) ||
    (BOUNCE_SUBJECT.test(subject) && !/^\s*(re|fw|fwd|отг)\s*:/i.test(subject))
  if (!isBounce) return null

  const text = bodyText(mail)

  // 1. Machine-readable delivery status (Gmail, Outlook/Exchange, Postfix, Exim, ...)
  const dsnRecipients = parseDsn(dsnText || (/^final-recipient:/im.test(text) ? text : ''))
  if (dsnRecipients.length > 0) {
    const permanent = dsnRecipients.filter(isPermanentDsnRecipient)
    return {
      permanent: permanent.length > 0,
      recipients: [...new Set((permanent.length > 0 ? permanent : dsnRecipients).map((r) => r.address))],
      mentionedAddresses: [],
    }
  }

  // 2. X-Failed-Recipients header (Exim, Gmail); free text decides permanence
  const headerRecipients = failedHeader
    .split(',')
    .map((s) => stripAddressType(s))
    .filter((s) => s.includes('@'))
  const permanent = textLooksPermanent(`${subject}\n${text}`)
  if (headerRecipients.length > 0) {
    return { permanent, recipients: [...new Set(headerRecipients)], mentionedAddresses: [] }
  }

  // 3. Plain-text bounce: the caller matches mentioned addresses against its leads
  const returnedMessage = attachmentText(mail, ['message/rfc822', 'text/rfc822-headers'])
  const mentioned = `${text}\n${returnedMessage}`.match(EMAIL) ?? []
  return {
    permanent,
    recipients: [],
    mentionedAddresses: [...new Set(mentioned.map((a) => a.toLowerCase()))],
  }
}
