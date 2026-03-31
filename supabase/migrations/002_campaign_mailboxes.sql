-- Junction table linking campaigns to their sending mailboxes.
-- This was missing from the initial schema but is required for round-robin
-- mailbox assignment and reply tracking.

CREATE TABLE campaign_mailboxes (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mailbox_id  UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, mailbox_id)
);

CREATE INDEX idx_campaign_mailboxes_mailbox_id ON campaign_mailboxes (mailbox_id);

ALTER TABLE campaign_mailboxes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campaign_mailboxes: tenant isolation"
  ON campaign_mailboxes FOR ALL
  USING (campaign_id IN (SELECT id FROM campaigns WHERE company_id = public.get_auth_company_id()))
  WITH CHECK (campaign_id IN (SELECT id FROM campaigns WHERE company_id = public.get_auth_company_id()));
