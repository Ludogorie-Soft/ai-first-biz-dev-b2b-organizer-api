import 'dotenv/config'
import express, { Application, Request, Response } from 'express'
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

// Swagger docs
const swaggerSpec = swaggerJsdoc({
  definition: {
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
  },
  apis: [
    process.env.NODE_ENV === 'production'
      ? './dist/src/routes/*.js'
      : './src/routes/*.ts',
  ],
})
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
