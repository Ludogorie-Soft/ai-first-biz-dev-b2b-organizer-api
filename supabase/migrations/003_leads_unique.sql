-- Add a unique constraint on (company_id, target_group_id, email) to the leads table.
-- This is required by the upsert in POST /leads/import which uses
-- onConflict: 'company_id,target_group_id,email' to avoid importing duplicate leads
-- within the same target group.

ALTER TABLE leads
  ADD CONSTRAINT leads_unique_email_per_group
  UNIQUE (company_id, target_group_id, email);
