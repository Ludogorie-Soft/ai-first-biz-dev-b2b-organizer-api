import { describe, expect, it } from 'vitest'
import {
  MAX_STYLED_HTML_BYTES,
  appendToStyledEmail,
  extractTemplateHtml,
  prepareStyledHtml,
  sanitizeEmailTemplate,
  styledHtmlToBody,
  styledHtmlToText,
} from './emailTemplate'
import { mergeVars } from './mergeVars'

describe('sanitizeEmailTemplate', () => {
  it('keeps table layout and inline styles', () => {
    const { html } = sanitizeEmailTemplate(
      '<body style="margin:0;background:#f3f4f0"><table role="presentation" width="100%" cellpadding="0"><tr><td style="padding:22px;color:#f8f9f5">Hi</td></tr></table></body>'
    )
    expect(html).toContain('<body style="margin:0;background:#f3f4f0">')
    expect(html).toContain('<table role="presentation" width="100%" cellpadding="0">')
    expect(html).toContain('<td style="padding:22px;color:#f8f9f5">Hi</td>')
  })

  it('removes scripts, event handlers and unsafe links', () => {
    const { html } = sanitizeEmailTemplate(
      '<body><script>alert(1)</script><p onclick="alert(2)">x</p><a href="javascript:alert(3)">y</a><iframe src="https://evil.test"></iframe><img src="https://a.test/i.png" onerror="alert(4)"></body>'
    )
    expect(html).not.toMatch(/alert|<script|onclick|onerror|<iframe|evil\.test/)
    expect(html).toContain('src="https://a.test/i.png"')
  })

  it('removes unsafe CSS but keeps style rules', () => {
    const { html } = sanitizeEmailTemplate(
      '<head><style>@import url(https://evil.test/x.css); a > b { color: red } .x { width: expression(alert(1)) }</style></head><body><p>x</p></body>'
    )
    expect(html).not.toMatch(/@import|expression\(|evil\.test/)
    expect(html).toContain('a > b { color: red }')
    expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('<body'))
  })

  it('drops the original title, which can name the original recipient', () => {
    const { html } = sanitizeEmailTemplate(
      '<html lang="bg"><head><title>Acme Ltd: offer</title></head><body><p>Hello</p></body></html>'
    )
    expect(html).not.toContain('Acme Ltd')
    expect(html).toContain('<html lang="bg">')
  })

  it('removes tracking pixels and reports them', () => {
    const { html, warnings } = sanitizeEmailTemplate(
      '<body><!--[if mso]> <img width="1" height="1" src="https://t.test/mso"> <![endif]--><!--[if !mso]><!--> <img style="display:none" src="https://t.test/open"> <!--<![endif]--><img width="186" height="50" src="https://a.test/logo.png"></body>'
    )
    expect(html).not.toContain('t.test')
    expect(html).toContain('a.test/logo.png')
    expect(warnings.removedTrackingPixels).toBe(1)
  })

  it('keeps content that is only hidden from Outlook', () => {
    const { html } = sanitizeEmailTemplate(
      '<body><!--[if !mso]><!--><p>For everyone else</p><!--<![endif]--><!--[if mso]><p>Outlook only</p><![endif]--></body>'
    )
    expect(html).toContain('For everyone else')
    expect(html).not.toContain('Outlook only')
  })

  it('clears embedded images and reports them', () => {
    const { html, warnings } = sanitizeEmailTemplate(
      '<body><img src="data:image/png;base64,AAAA" alt="logo"><img src="cid:abc"></body>'
    )
    expect(html).not.toMatch(/data:image|cid:/)
    expect(html).toContain('alt="logo"')
    expect(warnings.removedEmbeddedImages).toBe(2)
  })

  it('wraps fragments in a full document', () => {
    const { html } = sanitizeEmailTemplate('<p style="color:red">Hi</p>')
    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('<body><p style="color:red">Hi</p></body>')
  })

  it('preserves merge variables in text and links', () => {
    const { html } = sanitizeEmailTemplate(
      '<body><p>Hello {{company_name}}</p><a href="https://a.test/?c={{company_name}}">x</a></body>'
    )
    expect(html).toContain('Hello {{company_name}}')
    expect(html).toContain('href="https://a.test/?c={{company_name}}"')
  })

  it('is stable when an edited template is saved again', () => {
    const input =
      '<html><head><style>a > b { color: red }</style></head><body style="margin:0"><table><tr><td style="font-family:\'Arial\'">A &amp; B &nbsp;{{first_name}}<br></td></tr></table></body></html>'
    const once = sanitizeEmailTemplate(input).html
    expect(sanitizeEmailTemplate(once).html).toBe(once)
  })
})

describe('prepareStyledHtml', () => {
  it('rejects templates Gmail would clip', () => {
    const result = prepareStyledHtml(`<p>${'x'.repeat(MAX_STYLED_HTML_BYTES)}</p>`)
    expect(result).toHaveProperty('error')
  })

  it('measures bytes, since Cyrillic takes two per character', () => {
    const result = prepareStyledHtml(`<p>${'я'.repeat(MAX_STYLED_HTML_BYTES / 2 + 1)}</p>`)
    expect(result).toHaveProperty('error')
  })

  it('rejects templates without visible content', () => {
    expect(prepareStyledHtml('<body><script>x</script></body>')).toHaveProperty('error')
  })

  it('accepts image-only templates', () => {
    expect(prepareStyledHtml('<body><img src="https://a.test/x.png"></body>')).toHaveProperty('html')
  })
})

describe('extractTemplateHtml', () => {
  it('reads HTML from an EML file, decoding quoted-printable UTF-8', async () => {
    const eml = [
      'From: a@example.com',
      'Subject: Test',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p style=3D"color:red">=D0=97=D0=B4=D1=80=D0=B0=D0=B2=D0=B5=D0=B9=D1=82=D0=B5</p>',
    ].join('\r\n')
    const html = await extractTemplateHtml('mail.eml', Buffer.from(eml))
    expect(html).toContain('style="color:red"')
    expect(html).toContain('Здравейте')
  })

  it('fails on an EML file with no body', async () => {
    const eml = 'From: a@example.com\r\nSubject: Test\r\n\r\n'
    await expect(extractTemplateHtml('mail.eml', Buffer.from(eml))).rejects.toThrow('no HTML')
  })

  it('decodes windows-1251 HTML files', async () => {
    // "Здравей" in windows-1251
    const bytes = Buffer.from([0xc7, 0xe4, 0xf0, 0xe0, 0xe2, 0xe5, 0xe9])
    const html = await extractTemplateHtml('mail.html', bytes)
    expect(html).toBe('Здравей')
  })

  it('rejects other file types', async () => {
    await expect(extractTemplateHtml('mail.exe', Buffer.from('x'))).rejects.toThrow('not allowed')
  })
})

describe('appendToStyledEmail', () => {
  it('inserts blocks inside the body, once merged', () => {
    const merged = mergeVars('<html><body><p>Hi {{company_name}}</p></body></html>', {
      first_name: null,
      last_name: null,
      email: 'a@example.com',
      company_name: 'A&B <Ltd>',
      position: null,
    }, { html: true })
    const html = appendToStyledEmail(merged, '<p>Unsubscribe</p>')
    expect(html).toContain('Hi A&amp;B &lt;Ltd&gt;')
    expect(html.indexOf('Unsubscribe')).toBeLessThan(html.indexOf('</body>'))
    expect(html.indexOf('Unsubscribe')).toBeGreaterThan(html.indexOf('Hi A&amp;B'))
  })

  it('still appends when the document has no closing body tag', () => {
    expect(appendToStyledEmail('<p>Hi</p>', '<p>Unsubscribe</p>')).toContain('Unsubscribe')
  })
})

describe('styledHtmlToText', () => {
  it('returns visible text only', () => {
    const text = styledHtmlToText(
      '<html><head><style>a{color:red}</style></head><body><p>A &amp; B</p><table><tr><td>C</td></tr></table></body></html>'
    )
    expect(text).toBe('A & B\nC')
  })

  it('produces a non-empty stored body', () => {
    expect(styledHtmlToBody('<body><p>Hello</p><p>World</p></body>')).toBe('<p>Hello</p><p>World</p>')
  })
})
