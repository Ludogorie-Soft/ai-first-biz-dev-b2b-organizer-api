import { Lead } from '../types'
import { escapeHtml } from './emailHtml'

type LeadFields = Pick<Lead, 'first_name' | 'last_name' | 'email' | 'company_name' | 'position'>

function mergeVars(
  template: string,
  lead: LeadFields,
  options: { html?: boolean } = {}
): string {
  const transform = options.html ? escapeHtml : (value: string) => value

  const firstName = transform(lead.first_name || '')
  const lastName = transform(lead.last_name || '')
  const email = transform(lead.email || '')
  const fullName = transform(
    [lead.first_name, lead.last_name].filter(Boolean).join(' ') || ''
  )
  const companyName = transform(lead.company_name || '')
  const position = transform(lead.position || '')

  return template
    .replace(/\{\{first_name\}\}/gi, firstName)
    .replace(/\{\{last_name\}\}/gi, lastName)
    .replace(/\{\{email\}\}/gi, email)
    .replace(/\{\{full_name\}\}/gi, fullName)
    .replace(/\{\{company_name\}\}/gi, companyName)
    .replace(/\{\{position\}\}/gi, position)
}

export { mergeVars }
