import 'dotenv/config'
import { validateEnv } from './config/env'
validateEnv('server')

import app from './app'

const PORT = process.env.PORT ?? 3000

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`)
  console.log(`[Server] Swagger docs: http://localhost:${PORT}/api/docs`)
})
