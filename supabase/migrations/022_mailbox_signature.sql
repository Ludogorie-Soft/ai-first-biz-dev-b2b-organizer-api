-- Per-mailbox HTML email signature + sequence-level toggle

ALTER TABLE mailboxes
  ADD COLUMN IF NOT EXISTS signature TEXT;

ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS include_signature BOOLEAN NOT NULL DEFAULT true;
