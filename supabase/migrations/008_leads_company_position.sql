-- Add company_name and position columns to leads for use as email template variables.
ALTER TABLE leads
  ADD COLUMN company_name TEXT,
  ADD COLUMN position     TEXT;
