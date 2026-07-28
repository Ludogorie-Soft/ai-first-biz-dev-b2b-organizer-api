# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY worker.ts ./
COPY scripts ./scripts

RUN npm run build

# Stage 2: Production
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/openapi.json ./openapi.json

EXPOSE 3000

# API-only. Run workers separately: CMD ["node", "dist/worker.js"]
CMD ["node", "dist/src/server.js"]
