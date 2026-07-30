import sanitizeHtml from 'sanitize-html'

const EMAIL_BODY_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li'],
  allowedAttributes: {
    a: ['href', 'rel', 'target'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', {
      rel: 'noopener noreferrer',
      target: '_blank',
    }),
  },
}

function sanitizeEmailBody(html: string): string {
  return sanitizeHtml(html, EMAIL_BODY_SANITIZE_OPTIONS).trim()
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
