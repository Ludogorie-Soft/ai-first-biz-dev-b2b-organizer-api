-- Styled HTML email templates.
-- A sequence holds one uploaded template; each step that opts in keeps its own
-- editable copy, so its text can differ while the styling stays the same.

ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS template_html TEXT,
  ADD COLUMN IF NOT EXISTS template_file_name TEXT;

ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS use_template BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS styled_html TEXT;
