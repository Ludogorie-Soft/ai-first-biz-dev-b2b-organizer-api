-- Track the exact email address each log entry was sent to.
-- Allows distinguishing primary vs office email sends for the same lead.
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS recipient_email TEXT;
