-- Remove join_requests and audit_logs — new model is invite-only, no roles
DROP TABLE IF EXISTS join_requests;
DROP TABLE IF EXISTS audit_logs;
