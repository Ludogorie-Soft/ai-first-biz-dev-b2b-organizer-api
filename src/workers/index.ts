import { createEmailSenderWorker } from './emailSender'
import { startReplyCatcher } from './replyCatcher'

createEmailSenderWorker()
startReplyCatcher()

console.log('[Workers] Email sender and reply catcher started')
