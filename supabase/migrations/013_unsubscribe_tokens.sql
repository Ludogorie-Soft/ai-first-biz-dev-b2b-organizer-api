-- ============================================================
-- Migration 013: Unsubscribe tokens for GDPR compliance
-- Each lead gets one token. Clicking the link in any email
-- unsubscribes the address from all campaigns within the company.
-- ============================================================

CREATE TABLE unsubscribe_tokens (
  token      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    UUID NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_unsubscribe_tokens_lead_id ON unsubscribe_tokens (lead_id);
