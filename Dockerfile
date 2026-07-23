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

# Install Python and the backend Python deps (requests, used by the Cobalt
# download/validation scripts). Local STT models are no longer used in production.
COPY requirements.txt ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir --upgrade -r requirements.txt

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/swagger.yaml ./swagger.yaml
COPY --from=builder /app/scripts ./scripts
COPY public ./public
COPY test_audio ./test_audio
COPY *.py ./

# Make the startup script executable.
RUN chmod +x ./scripts/start.sh

ENV NODE_ENV=production

EXPOSE 3000

CMD ["./scripts/start.sh"]
