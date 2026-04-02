-- Stores short-lived tokens for the custom email-verification flow.
-- Tokens expire after 24 hours. One token per user at a time (delete+insert on re-send).

CREATE TABLE email_verifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token      UUID        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_verifications_token_idx ON email_verifications(token);
