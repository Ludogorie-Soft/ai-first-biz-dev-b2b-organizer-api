-- DB-backed email queue replacing BullMQ + Redis
CREATE TABLE IF NOT EXISTS email_queue (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name         text        UNIQUE,
  campaign_id      uuid        NOT NULL,
  sequence_id      uuid        NOT NULL,
  step_id          uuid        NOT NULL,
  lead_id          uuid        NOT NULL,
  mailbox_id       uuid        NOT NULL,
  send_on_weekends boolean     NOT NULL DEFAULT false,
  scheduled_at     timestamptz NOT NULL DEFAULT now(),
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts         int         NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Partial index: only pending rows need to be scanned by the cron poller
CREATE INDEX IF NOT EXISTS email_queue_pending_scheduled_idx
  ON email_queue (scheduled_at)
  WHERE status = 'pending';

-- Atomically claim up to batch_limit pending jobs that are due.
-- FOR UPDATE SKIP LOCKED ensures concurrent pollers never double-claim a row.
CREATE OR REPLACE FUNCTION claim_email_jobs(batch_limit int DEFAULT 5)
RETURNS SETOF email_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE email_queue
  SET    status     = 'processing',
         updated_at = now()
  WHERE  id IN (
    SELECT id
    FROM   email_queue
    WHERE  status       = 'pending'
      AND  scheduled_at <= now()
    ORDER  BY scheduled_at
    LIMIT  batch_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;
