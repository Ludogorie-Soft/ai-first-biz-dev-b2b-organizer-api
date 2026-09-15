import 'dotenv/config'
import './src/utils/timestampConsole'
import { validateEnv } from './src/config/env'
validateEnv('worker')

import { startEmailSender } from './src/workers/emailSender'
import { startReplyCatcher } from './src/workers/replyCatcher'

console.log(`[Worker] Starting email sender (pid=${process.pid})...`)
const emailSenderTimer: ReturnType<typeof setInterval> = startEmailSender()

console.log(`[Worker] Starting reply catcher (pid=${process.pid})...`)
const replyCatcherTimer: ReturnType<typeof setInterval> = startReplyCatcher()

async function shutdown(signal: string): Promise<void> {
  console.log(`[Worker] Received ${signal}, shutting down gracefully...`)
  clearInterval(emailSenderTimer)
  clearInterval(replyCatcherTimer)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
