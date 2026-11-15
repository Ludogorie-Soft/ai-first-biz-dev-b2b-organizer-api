-- Admin job history: aggregate email_queue rows into "jobs".
-- A job = all queued emails sharing the same campaign, sender mailbox,
-- sequence step and status. Used by the global-admin "Jobs" page.

CREATE OR REPLACE FUNCTION admin_email_job_groups(
  p_status      text DEFAULT NULL,
  p_campaign_id uuid DEFAULT NULL,
  p_limit       int  DEFAULT 500
)
RETURNS TABLE (
  campaign_id        uuid,
  campaign_name      text,
  campaign_status    text,
  is_warmup          boolean,
  company_id         uuid,
  company_name       text,
  mailbox_id         uuid,
  sender_email       text,
  sequence_id        uuid,
  sequence_name      text,
  step_id            uuid,
  step_order         int,
  status             text,
  email_count        bigint,
  first_scheduled_at timestamptz,
  last_scheduled_at  timestamptz,
  created_at         timestamptz,
  last_updated_at    timestamptz,
  error_count        bigint,   -- emails in the job that have a last_error
  errors             text[]    -- up to 5 distinct error messages
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    q.campaign_id,
    c.name,
    c.status::text,
    COALESCE(c.is_warmup, false),
    c.company_id,
    co.name,
    q.mailbox_id,
    m.email,
    q.sequence_id,
    sq.name,
    q.step_id,
    s.step_order,
    q.status,
    count(*)            AS email_count,
    min(q.scheduled_at) AS first_scheduled_at,
    max(q.scheduled_at) AS last_scheduled_at,
    min(q.created_at)   AS created_at,
    max(q.updated_at)   AS last_updated_at,
    count(q.last_error) AS error_count,
    COALESCE(
      (array_agg(DISTINCT q.last_error) FILTER (WHERE q.last_error IS NOT NULL))[1:5],
      ARRAY[]::text[]
    )                   AS errors
  FROM email_queue q
  LEFT JOIN campaigns      c  ON c.id  = q.campaign_id
  LEFT JOIN companies      co ON co.id = c.company_id
  LEFT JOIN mailboxes      m  ON m.id  = q.mailbox_id
  LEFT JOIN sequences      sq ON sq.id = q.sequence_id
  LEFT JOIN sequence_steps s  ON s.id  = q.step_id
  WHERE (p_status IS NULL OR q.status = p_status)
    AND (p_campaign_id IS NULL OR q.campaign_id = p_campaign_id)
  GROUP BY
    q.campaign_id, c.name, c.status, c.is_warmup, c.company_id, co.name,
    q.mailbox_id, m.email, q.sequence_id, sq.name, q.step_id, s.step_order, q.status
  ORDER BY max(q.updated_at) DESC
  LIMIT p_limit;
$$;

-- Cross-tenant data: only the backend (service_role) may call this.
REVOKE ALL ON FUNCTION admin_email_job_groups(text, uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_email_job_groups(text, uuid, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_email_job_groups(text, uuid, int) TO service_role;

-- Speeds up the per-status counts and the per-campaign breakdown
CREATE INDEX IF NOT EXISTS email_queue_status_idx      ON email_queue (status);
CREATE INDEX IF NOT EXISTS email_queue_campaign_id_idx ON email_queue (campaign_id);
