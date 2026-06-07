import { startEmailSender } from './emailSender'
import { startReplyCatcher } from './replyCatcher'

startEmailSender()
startReplyCatcher()

console.log('[Workers] Email sender and reply catcher started')
