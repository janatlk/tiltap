# TilTap Backend

AI-powered multilingual transcription and translation backend for Telegram and WhatsApp bots.

## Quick Start

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env and add your keys
   ```

3. **Run locally**
   ```bash
   npm run dev
   ```

4. **Build for production**
   ```bash
   npm run build
   npm start
   ```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `TELEGRAM_BOT_TOKEN` | Yes | From [@BotFather](https://t.me/BotFather) |
| `OPENAI_API_KEY` | Yes | From [OpenAI Platform](https://platform.openai.com) |
| `TRANSLATION_MODULE_URL` | No | Daniel's translation module endpoint (leave empty for GPT fallback) |
| `LOG_LEVEL` | No | `error`, `warn`, `info`, `debug` |

## Setting up the Telegram Bot Webhook

1. Expose your local server (e.g., via [ngrok](https://ngrok.com)):
   ```bash
   ngrok http 3000
   ```

2. Set the webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://<your-ngrok-url>/webhook/telegram"}'
   ```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/webhook/telegram` | Receives Telegram updates |
| POST | `/webhook/whatsapp` | WhatsApp placeholder |
| POST | `/api/translate` | Translation proxy (for Ernan's integration) |

## Demo Flow

1. Send a **video** or **voice message** to your Telegram bot.
2. Bot replies with transcribed subtitles including timecodes.
3. Tap a language button to get the full text translated.

## Docker

```bash
docker build -t tiltab-backend .
docker run -p 3000:3000 --env-file .env tiltab-backend
```

## Project Structure

```
src/
  config/         # Environment validation
  controllers/    # HTTP request handlers
  middleware/     # Express middleware
  routes/         # Route definitions
  services/       # Business logic (STT, translation, Telegram API)
  types/          # TypeScript interfaces
  utils/          # Logger
```

## License

Confidential — see project contract.
# tiltap
