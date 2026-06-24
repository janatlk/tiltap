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

# Install Python, yt-dlp, and minimal STT dependencies for priority languages.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip wget unzip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp vosk requests

# Download lightweight public Vosk fallback models for ky/tg/uz.
# Replace these with large/custom models if you need the same quality as local dev.
RUN mkdir -p models && cd models \
  && wget -q https://alphacephei.com/vosk/models/vosk-model-small-ky-0.42.zip \
  && wget -q https://alphacephei.com/vosk/models/vosk-model-small-tg-0.22.zip \
  && wget -q https://alphacephei.com/vosk/models/vosk-model-small-uz-0.22.zip \
  && unzip -q vosk-model-small-ky-0.42.zip \
  && unzip -q vosk-model-small-tg-0.22.zip \
  && unzip -q vosk-model-small-uz-0.22.zip \
  && rm -f *.zip

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
