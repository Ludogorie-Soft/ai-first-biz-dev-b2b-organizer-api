/**
 * Validates required environment variables at startup.
 *
 * API (server / Vercel) and worker (laptop) share most secrets but differ:
 * - SES_WEBHOOK_SECRET is API-only (SNS bounce/complaint webhook)
 * - SES_FROM_EMAIL is API-only (system mail: invites, verification, admin notify)
 * - Campaign sending + IMAP reply catching run only in the worker process
 */

const SHARED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'IMAP_ENCRYPTION_KEY',
  'FRONTEND_URL',
  'API_URL',
] as const

const SERVER_ONLY_VARS = [
  'SES_FROM_EMAIL',
  'SES_WEBHOOK_SECRET',
] as const

export function validateEnv(mode: 'server' | 'worker' = 'server'): void {
  const required =
    mode === 'worker' ? [...SHARED_VARS] : [...SHARED_VARS, ...SERVER_ONLY_VARS]

  const missing = required.filter((v) => !process.env[v])
  if (missing.length > 0) {
    console.error(
      `[Config] Missing required environment variables (${mode}):\n  ${missing.join('\n  ')}`
    )
    process.exit(1)
  }
}
