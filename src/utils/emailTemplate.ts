import xss, { safeAttrValue } from 'xss'
import { escapeHtml, sanitizeEmailBody } from './emailHtml'

/**
 * Gmail clips messages over ~102 KB, which would hide the unsubscribe link at
 * the bottom. The cap leaves room for the signature and unsubscribe block.
 */
export const MAX_STYLED_HTML_BYTES = 90 * 1024

export const TEMPLATE_EXTENSIONS = ['html', 'htm', 'eml']

export interface TemplateWarnings {
  /** Invisible tracking images inherited from the original sender. */
  removedTrackingPixels: number
  /** Images embedded in the file, which most email clients refuse to show. */
  removedEmbeddedImages: number
}

const COMMON_ATTRS = [
  'style', 'class', 'id', 'align', 'valign', 'width', 'height', 'bgcolor', 'dir', 'lang',
  'role', 'title', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'background',
  'color', 'face', 'size', 'aria-label', 'aria-hidden',
]

const ALLOWED_TAGS = [
  'body', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
  'center', 'div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'small', 'big', 'font', 'blockquote',
  'pre', 'code', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption',
  'address',
]

const WHITELIST: Record<string, string[]> = {
  ...Object.fromEntries(ALLOWED_TAGS.map((tag) => [tag, COMMON_ATTRS])),
  a: [...COMMON_ATTRS, 'href', 'target', 'rel', 'name'],
  img: [...COMMON_ATTRS, 'src', 'alt'],
}

function isTrackingPixel(tagHtml: string): boolean {
  if (/display\s*:\s*none/i.test(tagHtml)) return true
  const dimension = (name: string) =>
    tagHtml.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i'))?.[1]
  const width = dimension('width')
  const height = dimension('height')
  return width !== undefined && height !== undefined && Number(width) <= 1 && Number(height) <= 1
}

function sanitizeCss(css: string): string {
  return css
    .replace(/<!--|-->/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/behavior\s*:/gi, '')
    .replace(/-moz-binding\s*:/gi, '')
    .trim()
}

/** Removes Outlook-only blocks and unwraps the content hidden from Outlook. */
function resolveConditionalComments(html: string): string {
  return html
    .replace(/<!--\[if[^\]]*\]>\s*<!-->/gi, '')
    .replace(/<!--\s*<!\[endif\]\s*-->/gi, '')
    .replace(/<!--\[if[\s\S]*?<!\[endif\]\s*-->/gi, '')
}

/**
 * Reduces an uploaded HTML email to markup that is safe to store, edit and send:
 * only presentational tags survive, and the head is rebuilt from scratch because
 * the original <title> usually names the original recipient.
 */
export function sanitizeEmailTemplate(raw: string): { html: string; warnings: TemplateWarnings } {
  const warnings: TemplateWarnings = { removedTrackingPixels: 0, removedEmbeddedImages: 0 }

  const source = resolveConditionalComments(raw)

  const css = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)]
    .map((match) => sanitizeCss(match[1]))
    .filter(Boolean)

  const withoutStyles = source.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
  const bodyMatch = withoutStyles.match(/<body\b[^>]*>[\s\S]*<\/body\s*>/i)
  const bodySource = bodyMatch
    ? bodyMatch[0]
    : `<body>${withoutStyles.replace(/<!doctype[^>]*>|<\/?html\b[^>]*>|<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')}</body>`

  const body = xss(bodySource, {
    whiteList: WHITELIST,
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math'],
    allowCommentTag: false,
    css: false,
    onTag(tag, html, options) {
      if (tag === 'img' && !(options as { isClosing?: boolean }).isClosing && isTrackingPixel(html)) {
        warnings.removedTrackingPixels += 1
        return ''
      }
      return undefined
    },
    safeAttrValue(tag, name, value, cssFilter) {
      if (tag === 'img' && name === 'src' && /^\s*(data:|cid:)/i.test(value)) {
        warnings.removedEmbeddedImages += 1
        return ''
      }
      return safeAttrValue(tag, name, value, cssFilter)
    },
  }).trim()

  const lang = source.match(/<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]{2,12})/i)?.[1]
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...css.map((block) => `<style>${block}</style>`),
  ].join('\n')

  return {
    html: `<!DOCTYPE html>\n<html${lang ? ` lang="${lang}"` : ''}>\n<head>\n${head}\n</head>\n${body}\n</html>`,
    warnings,
  }
}

/** Plain-text rendering of a styled email, for logs and the required `body` column. */
export function styledHtmlToText(html: string): string {
  return html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|table|h[1-6]|li)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** Stored as the step's `body`, which is NOT NULL, when a styled step has no plain version. */
export function styledHtmlToBody(html: string): string {
  const paragraphs = styledHtmlToText(html)
    .split('\n')
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
  return sanitizeEmailBody(paragraphs.join(''))
}

/**
 * Sanitizes client-supplied styled HTML. Returns an error message for anything
 * that could not be sent as-is.
 */
export function prepareStyledHtml(
  raw: string
): { html: string; warnings: TemplateWarnings } | { error: string } {
  const { html, warnings } = sanitizeEmailTemplate(raw)
  if (Buffer.byteLength(html, 'utf8') > MAX_STYLED_HTML_BYTES) {
    return {
      error: `Template exceeds ${MAX_STYLED_HTML_BYTES / 1024} KB. Gmail would clip it and hide the unsubscribe link.`,
    }
  }
  if (!styledHtmlToText(html) && !/<img\b/i.test(html)) {
    return { error: 'Template has no visible content' }
  }
  return { html, warnings }
}

/** Honors the file's declared charset; legacy Bulgarian files are often windows-1251. */
function decodeHtmlFile(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    const declared = buffer
      .toString('latin1')
      .match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1]
    try {
      return new TextDecoder(declared || 'windows-1251').decode(buffer)
    } catch {
      return new TextDecoder('windows-1251').decode(buffer)
    }
  }
}

/** Extracts HTML from an uploaded template file. Throws with a user-facing message. */
export async function extractTemplateHtml(fileName: string, buffer: Buffer): Promise<string> {
  const extension = fileName.split('.').pop()?.toLowerCase() || ''
  if (!TEMPLATE_EXTENSIONS.includes(extension)) {
    throw new Error('File type not allowed. Use HTML or EML')
  }
  if (extension !== 'eml') return decodeHtmlFile(buffer)

  // Loaded on demand so the mail parser is not part of every API cold start
  const { simpleParser } = await import('mailparser')
  const parsed = await simpleParser(buffer)
  const html = parsed.html || parsed.textAsHtml
  if (!html) throw new Error('This email has no HTML content')
  return html
}

/** Places generated blocks (signature, unsubscribe) inside the document's body. */
export function appendToStyledEmail(html: string, blocks: string): string {
  const wrapped =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<div style="max-width:600px;margin:0 auto;padding:0 16px;text-align:left">${blocks}</div>` +
    `</td></tr></table>\n`
  const closing = html.toLowerCase().lastIndexOf('</body')
  return closing === -1
    ? html + wrapped
    : html.slice(0, closing) + wrapped + html.slice(closing)
}
