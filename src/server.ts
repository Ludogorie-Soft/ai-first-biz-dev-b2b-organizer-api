import 'dotenv/config'
import { validateEnv } from './config/env'
validateEnv('server')

import app from './app'
import { startEmailSender } from './workers/emailSender'
import { startReplyCatcher } from './workers/replyCatcher'

const PORT = process.env.PORT ?? 3000

const server = app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`)
  console.log(`[Server] Swagger docs: http://localhost:${PORT}/api/docs`)
})

const emailSenderTimer = startEmailSender()
const replyCatcherTimer = startReplyCatcher()

async function shutdown(signal: string): Promise<void> {
  console.log(`[Server] Received ${signal}, shutting down gracefully...`)
  clearInterval(emailSenderTimer)
  clearInterval(replyCatcherTimer)
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
