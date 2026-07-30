-- Per-step email file attachments (metadata + Supabase Storage paths)

CREATE TABLE sequence_step_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id      UUID NOT NULL REFERENCES sequence_steps (id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  storage_path TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sequence_step_attachments_step_id
  ON sequence_step_attachments (step_id);

-- Private bucket for attachment bytes (service role only via API)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('sequence-attachments', 'sequence-attachments', false, 4194304)
ON CONFLICT (id) DO NOTHING;
