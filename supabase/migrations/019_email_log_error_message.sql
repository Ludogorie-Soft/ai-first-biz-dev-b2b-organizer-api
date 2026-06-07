-- Add error_message column to email_logs to store failure details
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS error_message TEXT;
