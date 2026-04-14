-- ============================================================
-- Migration 011: Global Admin Role + Mailbox SES Approval Flow (DDL only)
-- NOTE: The UPDATE that uses 'global_admin' is in 012 because PostgreSQL
-- requires new enum values to be committed before they can be used.
-- ============================================================

-- 1. Add global_admin to the user_role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'global_admin';

-- 2. Add pending_mailbox_approval to campaign_status enum
ALTER TYPE campaign_status ADD VALUE IF NOT EXISTS 'pending_mailbox_approval';

-- 3. Add ses_status column to mailboxes
--    pending = registered but not yet verified in AWS SES
--    active  = verified in SES, ready to send
ALTER TABLE mailboxes
  ADD COLUMN IF NOT EXISTS ses_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (ses_status IN ('pending', 'active'));

-- 4. Existing mailboxes are assumed already in SES — mark them active
--    (ses_status is a plain TEXT column so this is safe in the same transaction)
UPDATE mailboxes SET ses_status = 'active' WHERE ses_status = 'pending';
