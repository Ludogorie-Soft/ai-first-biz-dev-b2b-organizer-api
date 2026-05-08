-- Store optional office email per lead for dual-recipient sends.
ALTER TABLE leads
  ADD COLUMN office_email TEXT;

CREATE INDEX idx_leads_office_email ON leads (office_email);
