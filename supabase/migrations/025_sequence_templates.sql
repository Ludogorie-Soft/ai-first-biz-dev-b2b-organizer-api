-- A sequence can hold several styled templates. Each step that opts in
-- keeps its own editable copy and records which template it was based on.

CREATE TABLE sequence_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID        NOT NULL REFERENCES sequences (id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  file_name   TEXT,
  html        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sequence_templates_sequence_id
  ON sequence_templates (sequence_id);

ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES sequence_templates (id) ON DELETE SET NULL;

CREATE INDEX idx_sequence_steps_template_id
  ON sequence_steps (template_id);

-- Move the single template that used to live on the sequence.
INSERT INTO sequence_templates (sequence_id, name, file_name, html)
SELECT
  id,
  COALESCE(NULLIF(btrim(template_file_name), ''), 'Template'),
  template_file_name,
  template_html
FROM sequences
WHERE template_html IS NOT NULL
  AND btrim(template_html) <> '';

UPDATE sequence_steps AS step
SET template_id = template.id
FROM sequence_templates AS template
WHERE step.sequence_id = template.sequence_id
  AND step.use_template = true
  AND step.template_id IS NULL;

-- The sequence row no longer stores the template. Steps already keep their own copy.
UPDATE sequences
SET template_html = NULL,
    template_file_name = NULL
WHERE template_html IS NOT NULL;

ALTER TABLE sequence_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sequence_templates: tenant isolation"
  ON sequence_templates
  FOR ALL
  USING (
    sequence_id IN (
      SELECT id FROM sequences WHERE company_id = public.get_auth_company_id()
    )
  )
  WITH CHECK (
    sequence_id IN (
      SELECT id FROM sequences WHERE company_id = public.get_auth_company_id()
    )
  );
