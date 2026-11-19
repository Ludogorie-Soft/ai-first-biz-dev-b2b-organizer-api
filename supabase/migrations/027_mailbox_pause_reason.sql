-- ============================================================
-- Migration 027: Why and when a mailbox was paused, and resuming it
--
-- A mailbox is auto-paused when its hard-bounce rate exceeds the
-- threshold. These columns record the reason and the numbers at that
-- moment, so the UI can explain the pause to users and admins.
--
-- bounce_check_since: set when a global admin resumes the mailbox.
-- The bounce-rate check only counts emails sent after it, so the old
-- bounces that caused the pause do not pause the mailbox again.
-- ============================================================

ALTER TABLE mailboxes
  ADD COLUMN IF NOT EXISTS paused_reason        TEXT,
  ADD COLUMN IF NOT EXISTS paused_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_bounce_rate   NUMERIC(5, 4),
  ADD COLUMN IF NOT EXISTS paused_bounced_count INT,
  ADD COLUMN IF NOT EXISTS paused_total_count   INT,
  ADD COLUMN IF NOT EXISTS bounce_check_since   TIMESTAMPTZ;

-- Until now the bounce-rate check was the only thing that paused a mailbox
UPDATE mailboxes
SET    paused_reason = 'high_bounce_rate'
WHERE  is_paused = true
  AND  paused_reason IS NULL;
