-- Per-campaign option to allow sending on Saturday/Sunday (default: workdays only Mon–Fri)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS send_on_weekends BOOLEAN NOT NULL DEFAULT false;
