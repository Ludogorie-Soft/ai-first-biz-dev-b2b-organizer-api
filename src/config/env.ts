/**
 * Validates required environment variables at startup.
 * Call this before starting the server.
 *
 * All background processors (email sender, reply catcher) now run inside the
 * API process, so all variables are required in every deployment.
 */

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'SES_FROM_EMAIL',
  'IMAP_ENCRYPTION_KEY',
  'FRONTEND_URL',
  'API_URL',
] as const

export function validateEnv(mode: 'server' | 'worker' = 'server'): void {
  void mode // mode parameter kept for backwards-compatibility with worker.ts
  const missing = REQUIRED_VARS.filter((v) => !process.env[v])
  if (missing.length > 0) {
    console.error(`[Config] Missing required environment variables:\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }
}
