/**
 * Generates openapi.json from route JSDoc so Swagger works on Vercel
 * (where CWD / dist globs are unreliable).
 */
const fs = require('fs')
const path = require('path')
const swaggerJsdoc = require('swagger-jsdoc')

const root = path.join(__dirname, '..')
const routesGlob = path.join(root, 'src', 'routes', '*.ts').replace(/\\/g, '/')

const spec = swaggerJsdoc({
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
  apis: [routesGlob],
})

const outPath = path.join(root, 'openapi.json')
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2))
console.log(`[OpenAPI] Wrote ${outPath}`)
