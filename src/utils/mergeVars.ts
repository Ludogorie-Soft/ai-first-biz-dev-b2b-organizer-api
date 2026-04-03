import { Lead } from '../types'

function mergeVars(template: string, lead: Pick<Lead, 'first_name' | 'last_name' | 'email' | 'company_name' | 'position'>): string {
  return template
    .replace(/\{\{first_name\}\}/gi, lead.first_name || '')
    .replace(/\{\{last_name\}\}/gi, lead.last_name || '')
    .replace(/\{\{email\}\}/gi, lead.email || '')
    .replace(
      /\{\{full_name\}\}/gi,
      [lead.first_name, lead.last_name].filter(Boolean).join(' ') || ''
    )
    .replace(/\{\{company_name\}\}/gi, lead.company_name || '')
    .replace(/\{\{position\}\}/gi, lead.position || '')
}

export { mergeVars }
