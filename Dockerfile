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

# Install Python and yt-dlp so YouTube validation/download scripts work in production.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/swagger.yaml ./swagger.yaml
COPY public ./public
COPY test_audio ./test_audio
COPY *.py ./

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.js"]
