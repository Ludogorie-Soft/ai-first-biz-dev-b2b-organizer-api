import xss from 'xss'

const EMAIL_XSS_OPTIONS: XSS.IFilterXSSOptions = {
  whiteList: {
    p: [],
    br: [],
    strong: [],
    b: [],
    em: [],
    i: [],
    u: [],
    a: ['href', 'rel', 'target'],
    ul: [],
    ol: [],
    li: [],
  },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style'],
  allowCommentTag: false,
  css: false,
  onTagAttr(tag, name, value) {
    if (tag === 'a' && name === 'href') {
      const href = String(value).trim()
      if (!/^(https?:|mailto:)/i.test(href)) {
        return ''
      }
    }
    return undefined
  },
}

function sanitizeEmailBody(html: string): string {
  let cleaned = xss(html, EMAIL_XSS_OPTIONS).trim()

  // Drop anchors that lost their href (e.g. javascript: filtered out)
  cleaned = cleaned.replace(/<a\b(?![^>]*\bhref\s*=)[^>]*>[\s\S]*?<\/a>/gi, '')

  // Ensure remaining anchors always get rel/target for email safety
  cleaned = cleaned.replace(/<a\b([^>]*)>/gi, (_match, attrs: string) => {
    let next = attrs
    if (!/\brel\s*=/i.test(next)) {
      next += ' rel="noopener noreferrer"'
    }
    if (!/\btarget\s*=/i.test(next)) {
      next += ' target="_blank"'
    }
    return `<a${next}>`
  })

  return cleaned
}

/** True when the string already contains email-body HTML tags. */
function looksLikeHtml(value: string): boolean {
  return /<\/?(?:p|br|strong|b|em|i|u|a|ul|ol|li)\b/i.test(value)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export { sanitizeEmailBody, looksLikeHtml, escapeHtml }
