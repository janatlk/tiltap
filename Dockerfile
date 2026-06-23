# Build stage
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY swagger.yaml ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Production stage
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/swagger.yaml ./swagger.yaml

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.js"]
