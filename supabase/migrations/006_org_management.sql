-- Org management: invitations only (invite-only model, all members have owner rights)

CREATE TABLE invitations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email      TEXT        NOT NULL,
  token      UUID        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  invited_by UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX invitations_token_idx ON invitations(token);
