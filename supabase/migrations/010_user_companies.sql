-- Many-to-many between users and companies.
-- A user can belong to multiple companies and switch between them.

CREATE TABLE user_companies (
  user_id    UUID NOT NULL REFERENCES users    (id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);

CREATE INDEX idx_user_companies_company_id ON user_companies (company_id);

-- Populate from existing users (each user's current company)
INSERT INTO user_companies (user_id, company_id)
SELECT id, company_id FROM users
ON CONFLICT DO NOTHING;

-- RLS: users can only see/manage their own memberships
ALTER TABLE user_companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_companies: own rows only"
  ON user_companies
  FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
