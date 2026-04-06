-- Move leads from target_group ownership to campaign ownership.
-- Leads are now directly linked to a campaign instead of a target group.

-- 1. Drop old unique constraint and index
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_unique_email_per_group;
DROP INDEX IF EXISTS idx_leads_target_group_id;

-- 2. Delete existing leads (they reference target_group_id which no longer exists)
DELETE FROM leads;

-- 3. Add campaign_id column
ALTER TABLE leads ADD COLUMN campaign_id UUID REFERENCES campaigns (id) ON DELETE CASCADE;

-- 4. Drop target_group_id column
ALTER TABLE leads DROP COLUMN target_group_id;

-- 5. Enforce NOT NULL (safe after DELETE above)
ALTER TABLE leads ALTER COLUMN campaign_id SET NOT NULL;

-- 5. New unique constraint: one email per campaign
ALTER TABLE leads ADD CONSTRAINT leads_unique_email_per_campaign UNIQUE (company_id, campaign_id, email);

-- 6. Index for campaign-scoped queries
CREATE INDEX idx_leads_campaign_id ON leads (campaign_id);
