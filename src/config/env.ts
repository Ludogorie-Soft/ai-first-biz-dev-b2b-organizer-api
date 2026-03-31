/**
 * Validates required environment variables at startup.
 * Call this before starting the server or worker.
 */

const REQUIRED_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REDIS_URL'] as const

const WORKER_REQUIRED_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'SES_FROM_EMAIL',
  'IMAP_ENCRYPTION_KEY',
] as const

export function validateEnv(mode: 'server' | 'worker' = 'server'): void {
  const vars = mode === 'worker' ? [...REQUIRED_VARS, ...WORKER_REQUIRED_VARS] : REQUIRED_VARS
  const missing = vars.filter((v) => !process.env[v])
  if (missing.length > 0) {
    console.error(`[Config] Missing required environment variables:\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }
}
