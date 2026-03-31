-- ============================================================
-- B2B Outreach Platform — Initial Schema
-- Migration: 001_initial_schema.sql
-- All tables are secured via RLS using company_id.
-- ============================================================

-- Enable pgcrypto for UUID generation (Supabase has this by default)
-- gen_random_uuid() is available in PostgreSQL 13+ without extension

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE lead_status AS ENUM (
  'active',
  'replied',
  'unsubscribed',
  'bounced',
  'opted_out'
);

CREATE TYPE campaign_status AS ENUM (
  'draft',
  'active',
  'paused',
  'completed'
);

CREATE TYPE email_log_status AS ENUM (
  'pending',
  'sent',
  'failed',
  'bounced'
);

CREATE TYPE reply_category AS ENUM (
  'positive',
  'negative',
  'neutral',
  'out_of_office'
);

CREATE TYPE user_role AS ENUM (
  'owner',
  'admin',
  'member'
);

-- ============================================================
-- TABLE: companies
-- Top-level tenant entity. Every other table isolates by company_id.
-- ============================================================

CREATE TABLE companies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  website     TEXT,
  industry    TEXT,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TABLE: users
-- Platform users — maps 1-to-1 with Supabase Auth (auth.users).
-- ============================================================

CREATE TABLE users (
  id         UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  company_id UUID        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  role       user_role   NOT NULL DEFAULT 'member',
  email      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_company_id ON users (company_id);

-- ============================================================
-- TABLE: mailboxes
-- Sender email accounts + encrypted IMAP config for reply catching.
-- imap_config stores the vault secret reference or encrypted JSON.
-- ============================================================

CREATE TABLE mailboxes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  imap_config JSONB,          -- encrypted via Supabase Vault before insert
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mailboxes_company_id ON mailboxes (company_id);

-- ============================================================
-- TABLE: target_groups
-- Folders / lists for organizing leads (e.g., "Online Stores BG").
-- ============================================================

CREATE TABLE target_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_target_groups_company_id ON target_groups (company_id);

-- ============================================================
-- TABLE: leads
-- Contact details of prospects linked to a specific Target Group.
-- ============================================================

CREATE TABLE leads (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  target_group_id UUID        NOT NULL REFERENCES target_groups (id) ON DELETE CASCADE,
  email           TEXT        NOT NULL,
  first_name      TEXT,
  last_name       TEXT,
  status          lead_status NOT NULL DEFAULT 'active',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leads_company_id      ON leads (company_id);
CREATE INDEX idx_leads_target_group_id ON leads (target_group_id);
CREATE INDEX idx_leads_email           ON leads (email);

-- ============================================================
-- TABLE: sequences
-- Container for ordered email steps.
-- ============================================================

CREATE TABLE sequences (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sequences_company_id ON sequences (company_id);

-- ============================================================
-- TABLE: sequence_steps
-- Ordered steps belonging to a sequence.
-- In v1.1, subject/body will act as AI prompt templates.
-- ============================================================

CREATE TABLE sequence_steps (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID    NOT NULL REFERENCES sequences (id) ON DELETE CASCADE,
  step_order  INTEGER NOT NULL,
  subject     TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  delay_days  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (sequence_id, step_order)
);

CREATE INDEX idx_sequence_steps_sequence_id ON sequence_steps (sequence_id);

-- ============================================================
-- TABLE: campaigns
-- Main engine linking a target group to execution logic.
-- ============================================================

CREATE TABLE campaigns (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID            NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  target_group_id UUID            NOT NULL REFERENCES target_groups (id) ON DELETE RESTRICT,
  name            TEXT            NOT NULL,
  status          campaign_status NOT NULL DEFAULT 'draft',
  description     TEXT,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaigns_company_id      ON campaigns (company_id);
CREATE INDEX idx_campaigns_target_group_id ON campaigns (target_group_id);

-- ============================================================
-- TABLE: campaign_sequences
-- Junction table — links a campaign to one or more sequences.
-- Prepares the system for A/B testing in v1.1.
-- ============================================================

CREATE TABLE campaign_sequences (
  campaign_id UUID NOT NULL REFERENCES campaigns  (id) ON DELETE CASCADE,
  sequence_id UUID NOT NULL REFERENCES sequences  (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (campaign_id, sequence_id)
);

CREATE INDEX idx_campaign_sequences_sequence_id ON campaign_sequences (sequence_id);

-- ============================================================
-- TABLE: email_logs
-- Tracks execution per lead. Stores actual personalized text sent.
-- ============================================================

CREATE TABLE email_logs (
  id             UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID             NOT NULL REFERENCES campaigns      (id) ON DELETE CASCADE,
  sequence_id    UUID             NOT NULL REFERENCES sequences      (id) ON DELETE CASCADE,
  step_id        UUID             NOT NULL REFERENCES sequence_steps (id) ON DELETE CASCADE,
  lead_id        UUID             NOT NULL REFERENCES leads          (id) ON DELETE CASCADE,
  mailbox_id     UUID             NOT NULL REFERENCES mailboxes      (id) ON DELETE CASCADE,
  status         email_log_status NOT NULL DEFAULT 'pending',
  reply_category reply_category,
  sent_subject   TEXT,
  sent_body      TEXT,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_logs_campaign_id ON email_logs (campaign_id);
CREATE INDEX idx_email_logs_lead_id     ON email_logs (lead_id);
CREATE INDEX idx_email_logs_status      ON email_logs (status);

-- ============================================================
-- ROW LEVEL SECURITY
-- Helper function: returns the company_id of the current user.
--
-- SECURITY DEFINER is required to break the RLS infinite recursion loop:
-- Without it, calling this function from a users policy would cause
-- Postgres to re-evaluate the users policy → call this function → repeat.
-- SECURITY DEFINER runs as the function owner (bypasses RLS on users).
-- Placed in public schema because Supabase restricts the auth schema.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_auth_company_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT company_id
  FROM   public.users
  WHERE  id = auth.uid()
$$;

-- ============================================================
-- RLS: companies
-- Users can only see/edit their own company row.
-- ============================================================

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "companies: tenant isolation"
  ON companies
  FOR ALL
  USING  (id = public.get_auth_company_id())
  WITH CHECK (id = public.get_auth_company_id());

-- ============================================================
-- RLS: users
-- Users can see all team members in their company,
-- but can only update/delete their own row.
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users: read own company members"
  ON users
  FOR SELECT
  USING (company_id = public.get_auth_company_id());

CREATE POLICY "users: insert own row"
  ON users
  FOR INSERT
  WITH CHECK (id = auth.uid() AND company_id = public.get_auth_company_id());

CREATE POLICY "users: update own row"
  ON users
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "users: delete own row"
  ON users
  FOR DELETE
  USING (id = auth.uid());

-- ============================================================
-- RLS: mailboxes
-- ============================================================

ALTER TABLE mailboxes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mailboxes: tenant isolation"
  ON mailboxes
  FOR ALL
  USING  (company_id = public.get_auth_company_id())
  WITH CHECK (company_id = public.get_auth_company_id());

-- ============================================================
-- RLS: target_groups
-- ============================================================

ALTER TABLE target_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "target_groups: tenant isolation"
  ON target_groups
  FOR ALL
  USING  (company_id = public.get_auth_company_id())
  WITH CHECK (company_id = public.get_auth_company_id());

-- ============================================================
-- RLS: leads
-- ============================================================

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "leads: tenant isolation"
  ON leads
  FOR ALL
  USING  (company_id = public.get_auth_company_id())
  WITH CHECK (company_id = public.get_auth_company_id());

-- ============================================================
-- RLS: sequences
-- ============================================================

ALTER TABLE sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sequences: tenant isolation"
  ON sequences
  FOR ALL
  USING  (company_id = public.get_auth_company_id())
  WITH CHECK (company_id = public.get_auth_company_id());

-- ============================================================
-- RLS: sequence_steps
-- No direct company_id — access via parent sequence.
-- ============================================================

ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sequence_steps: tenant isolation"
  ON sequence_steps
  FOR ALL
  USING (
    sequence_id IN (
      SELECT id FROM sequences WHERE company_id = public.get_auth_company_id()
    )
  )
  WITH CHECK (
    sequence_id IN (
      SELECT id FROM sequences WHERE company_id = public.get_auth_company_id()
    )
  );

-- ============================================================
-- RLS: campaigns
-- ============================================================

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campaigns: tenant isolation"
  ON campaigns
  FOR ALL
  USING  (company_id = public.get_auth_company_id())
  WITH CHECK (company_id = public.get_auth_company_id());

-- ============================================================
-- RLS: campaign_sequences
-- No direct company_id — access via parent campaign.
-- ============================================================

ALTER TABLE campaign_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campaign_sequences: tenant isolation"
  ON campaign_sequences
  FOR ALL
  USING (
    campaign_id IN (
      SELECT id FROM campaigns WHERE company_id = public.get_auth_company_id()
    )
  )
  WITH CHECK (
    campaign_id IN (
      SELECT id FROM campaigns WHERE company_id = public.get_auth_company_id()
    )
  );

-- ============================================================
-- RLS: email_logs
-- Accessed via campaign which carries company_id.
-- ============================================================

ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_logs: tenant isolation"
  ON email_logs
  FOR ALL
  USING (
    campaign_id IN (
      SELECT id FROM campaigns WHERE company_id = public.get_auth_company_id()
    )
  )
  WITH CHECK (
    campaign_id IN (
      SELECT id FROM campaigns WHERE company_id = public.get_auth_company_id()
    )
  );
