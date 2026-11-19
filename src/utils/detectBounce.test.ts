import { describe, expect, it } from 'vitest'
import { simpleParser } from 'mailparser'
import { detectBounce } from './detectBounce'

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n')
const parse = (raw: string) => simpleParser(crlf(raw))

const ORIGINAL = `From: Sales <sales@ourcompany.com>
To: john.doe@client.bg
Subject: Quick question
Message-ID: <abc@ourcompany.com>

Hello John`

function dsnReport(opts: {
  from: string
  subject: string
  human: string
  dsn: string
  extraHeaders?: string
}): string {
  return `From: ${opts.from}
To: sales@ourcompany.com
Subject: ${opts.subject}
${opts.extraHeaders ?? ''}MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="BOUND"

--BOUND
Content-Type: text/plain; charset=utf-8

${opts.human}

--BOUND
Content-Type: message/delivery-status

${opts.dsn}

--BOUND
Content-Type: message/rfc822

${ORIGINAL}

--BOUND--
`
}

describe('detectBounce', () => {
  it('reads a Gmail permanent failure', async () => {
    const mail = await parse(
      dsnReport({
        from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
        subject: 'Delivery Status Notification (Failure)',
        extraHeaders: 'X-Failed-Recipients: john.doe@client.bg\n',
        human: "Address not found. Your message wasn't delivered to john.doe@client.bg because the address couldn't be found.",
        dsn: `Reporting-MTA: dns; googlemail.com
Arrival-Date: Wed, 18 Nov 2026 10:00:00 -0800

Final-Recipient: rfc822; john.doe@client.bg
Action: failed
Status: 5.1.1
Remote-MTA: dns; mx.client.bg
Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.`,
      })
    )
    expect(detectBounce(mail)).toEqual({
      permanent: true,
      recipients: ['john.doe@client.bg'],
      mentionedAddresses: [],
    })
  })

  it('reads an Outlook/Exchange NDR with a folded Diagnostic-Code and mixed-case address', async () => {
    const mail = await parse(
      dsnReport({
        from: 'postmaster@client.onmicrosoft.com',
        subject: 'Undeliverable: Quick question',
        human: "Your message to John.Doe@Client.bg couldn't be delivered. John.Doe wasn't found at client.bg.",
        dsn: `Reporting-MTA: dns;AM0PR01MB1234.eurprd01.prod.outlook.com

Original-Recipient: rfc822;John.Doe@Client.bg
Final-Recipient: rfc822;John.Doe@Client.bg
Action: failed
Status: 5.1.10
Diagnostic-Code: smtp;550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient
 not found by SMTP address lookup`,
      })
    )
    expect(detectBounce(mail)).toMatchObject({ permanent: true, recipients: ['john.doe@client.bg'] })
  })

  it('treats a delayed (4.x.x) report as temporary', async () => {
    const mail = await parse(
      dsnReport({
        from: 'MAILER-DAEMON@mail.ourcompany.com (Mail Delivery System)',
        subject: 'Delayed Mail (still being retried)',
        human: 'This is the mail system. Your message could not be delivered for 4 hours. It will be retried.',
        dsn: `Reporting-MTA: dns; mail.ourcompany.com

Final-Recipient: rfc822; john.doe@client.bg
Action: delayed
Status: 4.4.1
Diagnostic-Code: X-Postfix; connect to mx.client.bg: Connection timed out`,
      })
    )
    expect(detectBounce(mail)).toMatchObject({ permanent: false, recipients: ['john.doe@client.bg'] })
  })

  it('treats a full mailbox (4.2.2) as temporary', async () => {
    const mail = await parse(
      dsnReport({
        from: 'Mail Delivery System <MAILER-DAEMON@mx.client.bg>',
        subject: 'Undelivered Mail Returned to Sender',
        human: 'Mailbox full.',
        dsn: `Final-Recipient: rfc822; john.doe@client.bg
Action: failed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 Mailbox full`,
      })
    )
    expect(detectBounce(mail)?.permanent).toBe(false)
  })

  it('reads a plain-text Exim bounce from X-Failed-Recipients', async () => {
    const mail = await parse(`From: Mail Delivery System <Mailer-Daemon@mx.client.bg>
To: sales@ourcompany.com
Subject: Mail delivery failed: returning message to sender
X-Failed-Recipients: john.doe@client.bg
Content-Type: text/plain; charset=utf-8

This message was created automatically by mail delivery software.

A message that you sent could not be delivered to one or more of its
recipients. This is a permanent error. The following address(es) failed:

  john.doe@client.bg
    SMTP error from remote mail server after RCPT TO:<john.doe@client.bg>:
    550 No Such User Here
`)
    expect(detectBounce(mail)).toEqual({
      permanent: true,
      recipients: ['john.doe@client.bg'],
      mentionedAddresses: [],
    })
  })

  it('collects mentioned addresses from a plain-text bounce without recipient fields', async () => {
    const mail = await parse(`From: postmaster@client.bg
To: sales@ourcompany.com
Subject: Недоставено съобщение
Content-Type: text/plain; charset=utf-8

Съобщението до john.doe@client.bg не беше доставено: адресът не съществува.
`)
    const bounce = detectBounce(mail)
    expect(bounce).toMatchObject({ permanent: true, recipients: [] })
    expect(bounce?.mentionedAddresses).toContain('john.doe@client.bg')
  })

  it('ignores a normal reply from a lead', async () => {
    const mail = await parse(`From: John Doe <john.doe@client.bg>
To: sales@ourcompany.com
Subject: Re: Quick question
Content-Type: text/plain; charset=utf-8

Sounds good, let's talk next week. My colleague's address does not exist anymore though.
`)
    expect(detectBounce(mail)).toBeNull()
  })

  it('ignores a human reply whose subject mentions an undeliverable message', async () => {
    const mail = await parse(`From: John Doe <john.doe@client.bg>
To: sales@ourcompany.com
Subject: RE: Undeliverable: Quick question
Content-Type: text/plain; charset=utf-8

I got an undeliverable notice, please use my other address.
`)
    expect(detectBounce(mail)).toBeNull()
  })
})
