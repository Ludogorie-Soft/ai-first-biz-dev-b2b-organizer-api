-- Friendly-contacts warmup: a mailbox sends to people who agreed to engage with
-- its emails before it starts sending normal outreach.
--
-- mailboxes.friendly_warmup_pending: while true, only warmup campaigns can send
--   from this mailbox. Cleared when a warmup campaign using it completes, or by
--   hand through PATCH /mailboxes/:id.
-- campaigns.is_warmup: marks a campaign whose leads are friendly contacts.

ALTER TABLE mailboxes
  ADD COLUMN IF NOT EXISTS friendly_warmup_pending BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS is_warmup BOOLEAN NOT NULL DEFAULT false;
