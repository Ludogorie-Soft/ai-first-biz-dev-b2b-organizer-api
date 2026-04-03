export interface User {
  id: string
  email: string
  company_id: string
  role: 'owner' | 'admin' | 'member'
}

export interface Lead {
  id: string
  company_id: string
  target_group_id: string
  email: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  position: string | null
  status: 'active' | 'replied' | 'unsubscribed' | 'bounced' | 'opted_out'
  notes: string | null
  created_at: string
}

export interface SequenceStep {
  id: string
  sequence_id: string
  step_order: number
  subject: string
  body: string
  delay_days: number
  created_at: string
}

export interface Mailbox {
  id: string
  company_id: string
  email: string
  imap_config: EncryptedPayload | null
  created_at: string
}

export interface EncryptedPayload {
  iv: string
  tag: string
  data: string
}

export interface ImapConfig {
  host: string
  port: number
  tls: boolean
  user: string
  password: string
}

export interface EmailJobData {
  campaignId: string
  sequenceId: string
  stepId: string
  leadId: string
  mailboxId: string
}

export type ReplyCategory = 'positive' | 'negative' | 'neutral' | 'out_of_office'
export type EmailLogStatus = 'pending' | 'sent' | 'failed' | 'bounced'
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed'
