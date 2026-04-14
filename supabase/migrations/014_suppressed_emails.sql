-- ============================================================
-- Migration 014: Persistent email suppression list
-- Survives campaign/lead deletion. Once an email unsubscribes
-- for a company it can never be re-activated by a new import.
-- ============================================================

-- Fix missing unique index from migration 013
CREATE UNIQUE INDEX IF NOT EXISTS idx_unsubscribe_tokens_lead_id
  ON unsubscribe_tokens (lead_id);

-- Suppression list: one row per company+email that has unsubscribed
CREATE TABLE suppressed_emails (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  email      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, email)
);

CREATE INDEX idx_suppressed_emails_company_email ON suppressed_emails (company_id, email);

-- Backfill: any lead already marked unsubscribed goes into the suppression list
INSERT INTO suppressed_emails (company_id, email)
SELECT DISTINCT company_id, email
FROM leads
WHERE status = 'unsubscribed'
ON CONFLICT (company_id, email) DO NOTHING;
