-- ============================================================
-- Migration 012: Assign global_admin role to platform administrators
-- This is separate from 011 because PostgreSQL does not allow using
-- a newly added enum value in the same transaction it was created in.
-- ============================================================

UPDATE users
SET role = 'global_admin'
WHERE email IN ('alkinvejdi@gmail.com', 'e.kadiyski@gmail.com');
