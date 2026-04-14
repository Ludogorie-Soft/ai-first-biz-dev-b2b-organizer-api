import 'dotenv/config'
import { validateEnv } from './src/config/env'
validateEnv('worker')

import { createEmailSenderWorker } from './src/workers/emailSender'
import { startReplyCatcher } from './src/workers/replyCatcher'
import { Worker } from 'bullmq'
import { EmailJobData } from './src/types'

console.log(`[Worker] Starting email sender worker (pid=${process.pid})...`)
const emailWorker: Worker<EmailJobData> = createEmailSenderWorker()

console.log(`[Worker] Starting reply catcher (pid=${process.pid})...`)
const replyCatcherTimer: ReturnType<typeof setInterval> = startReplyCatcher()

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`[Worker] Received ${signal}, shutting down gracefully...`)
  clearInterval(replyCatcherTimer)
  await emailWorker.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
