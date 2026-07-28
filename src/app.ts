import 'dotenv/config'
import express, { Application, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import helmet from 'helmet'
import cors from 'cors'
import morgan from 'morgan'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import { errorHandler } from './middleware/errorHandler'

// Routes
import authRoutes from './routes/auth'
import companyRoutes from './routes/company'
import mailboxRoutes from './routes/mailboxes'
import targetGroupRoutes from './routes/targetGroups'
import leadRoutes from './routes/leads'
import sequenceRoutes from './routes/sequences'
import campaignRoutes from './routes/campaigns'
import dashboardRoutes from './routes/dashboard'
import webhookRoutes from './routes/webhooks'
import orgRoutes from './routes/org'
import companiesRoutes from './routes/companies'
import adminRoutes from './routes/admin'
import unsubscribeRoutes from './routes/unsubscribe'

const app: Application = express()

// Disable ETag generation — all API responses are user-specific so browser
// caching via If-None-Match / 304 would serve stale data across sessions.
app.set('etag', false)

// Security & parsing middleware
app.use(helmet())
app.use(cors())
app.use(morgan('dev'))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
// SNS sends notifications as text/plain containing a JSON string
app.use(express.text({ type: 'text/plain' }))

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'B2B Organizer API',
    version: '1.0.0',
    description: 'B2B Email Outreach Platform API',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
}

function loadSwaggerSpec(): object {
  const candidates = [
    path.join(process.cwd(), 'openapi.json'),
    path.join(__dirname, '..', '..', 'openapi.json'),
    path.join(__dirname, '..', 'openapi.json'),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')) as object
      }
    } catch {
      // try next candidate
    }
  }

  // Local/dev fallback when openapi.json has not been generated yet
  return swaggerJsdoc({
    definition: swaggerDefinition,
    apis: [path.join(__dirname, 'routes', '*.ts').replace(/\\/g, '/')],
  }) as object
}

const swaggerSpec = loadSwaggerSpec()
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))

// API routes
app.use('/api/auth', authRoutes)
app.use('/api/company', companyRoutes)
app.use('/api/mailboxes', mailboxRoutes)
app.use('/api/target-groups', targetGroupRoutes)
app.use('/api/leads', leadRoutes)
app.use('/api/sequences', sequenceRoutes)
app.use('/api/campaigns', campaignRoutes)
app.use('/api/campaigns', dashboardRoutes)
app.use('/api/org', orgRoutes)
app.use('/api/companies', companiesRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/unsubscribe', unsubscribeRoutes)
app.use('/webhooks/ses', webhookRoutes)

// Health check
app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }))

// 404 handler
app.use((_req: Request, res: Response) => res.status(404).json({ error: 'Route not found' }))

// Global error handler (must be last)
app.use(errorHandler)

export default app
