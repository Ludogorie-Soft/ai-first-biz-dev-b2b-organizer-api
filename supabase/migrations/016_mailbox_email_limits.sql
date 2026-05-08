-- Add configurable daily and weekly email send limits per mailbox.
-- These represent the target maximum once the mailbox is fully warmed up.
-- The warmup ramp (8 → 12 → target) still applies; the admin-configured value
-- is the ceiling that the ramp works towards.
-- Defaults: 20 emails/day and 100 emails/week.

ALTER TABLE mailboxes
  ADD COLUMN daily_email_limit  INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN weekly_email_limit INTEGER NOT NULL DEFAULT 100;
