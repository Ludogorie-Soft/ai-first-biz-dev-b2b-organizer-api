-- Add warmup tracking and pause flag to mailboxes.
-- warmup_started_at: when this mailbox first started sending — drives the daily limit ramp.
-- is_paused: set to true automatically when bounce rate exceeds threshold, or manually.

ALTER TABLE mailboxes
  ADD COLUMN warmup_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN is_paused          BOOLEAN     NOT NULL DEFAULT FALSE;
