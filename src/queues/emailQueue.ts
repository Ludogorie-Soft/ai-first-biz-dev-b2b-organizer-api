import { Queue } from 'bullmq'
import { redis } from '../config/redis'
import { EmailJobData } from '../types'

const emailQueue = new Queue<EmailJobData>('email-sending', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
})

export { emailQueue }
