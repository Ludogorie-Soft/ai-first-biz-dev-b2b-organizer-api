import 'dotenv/config'
import { Redis } from 'ioredis'

const redis = new Redis(process.env.REDIS_URL as string, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? {} : undefined,
})

redis.on('error', (err: Error) => console.error('[Redis] connection error:', err.message))

export { redis }
