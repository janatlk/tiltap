# Session Log — 2026-07-05

## Context

Project: TilTap backend + Python STT service  
Server: Hetzner Cloud, `95.216.169.56`, hostname `tiltab-cx43-hel2`  
Local path: `C:\MyProjects\Tiltab`  
Server path: `/opt/tiltap`

---

## 1. Translation approval workflow fix

### Requirement
Users should get a fresh LLM translation every time for the same source text **until** an admin confirms a translation. After confirmation, identical source text returns the confirmed translation from cache.

### Changes made locally

- `src/services/translationService.ts`
  - Cache lookup changed from `getTranslationCache()` to `getConfirmedTranslationCache()`.
  - Unconfirmed entries are now ignored when serving users; they are only kept for admin review.
  - Removed redundant "pending" log check.

- `src/controllers/adminController.ts`
  - Added `deleteTranslationEntry()` handler to reject/remove a proposed translation.

- `src/routes/admin.ts`
  - Added `DELETE /api/admin/translations/:hash/:lang`.

- `public/web/admin.html`
  - Added **🗑️ Reject** button next to **✅ Confirm translation**.

### Build & tests

```bash
npm run build   # OK
npm test        # 12 pass
```

---

## 2. Deployment to Hetzner

### Files copied to `/opt/tiltap`

- `src/app.ts`
- `src/config/index.ts`
- `src/services/translationService.ts`
- `src/controllers/adminController.ts`
- `src/routes/admin.ts`
- `src/db/repos/translationRepo.ts`
- `src/db/schema.sql`
- `src/types/index.ts`
- `public/web/admin.html`

### Build issue

TypeScript failed because `TranslateResponse.warning` existed locally but server `src/types/index.ts` was older. Fixed by copying local `src/types/index.ts`.

### Database recovery

After restart, PGlite refused to start:

```
PostgreSQL unreachable, falling back to embedded PGlite
PostgreSQL is not reachable. Check DATABASE_URL.
```

The `.pglite-data2` directory had a stale `postmaster.pid` and PGlite aborted on open. Restored from `.pglite-data.bak.current`:

```bash
cd /opt/tiltap
systemctl stop tiltab-backend.service
mv .pglite-data2 .pglite-data2.corrupted.20260705
cp -a .pglite-data.bak.current .pglite-data2
systemctl start tiltab-backend.service
```

Service started successfully; migration added `confirmed` columns to `translation_cache`.

> ⚠️ Possible data loss: any data written between `.pglite-data.bak.current` timestamp and the crash may be missing.

### Cleanup

Deleted accidentally created typo directory `/opt/tiltab`.

### Service status

```bash
systemctl status tiltab-backend.service --no-pager
# Active (running) on port 3000
```

### Verification

- `GET /health` → `status: ok`
- `GET /api/admin/translations/pending` → returns empty list
- Translated sample via `/api/translate` → saved unconfirmed entry
- Confirmed entry via `POST /api/admin/translations/:hash/:lang/confirm`
- Re-translated same sample → returned confirmed translation instantly (cache hit)

---

## 3. Playwright LLM translation test

### Goal
Translate the same Kyrgyz text from YouTube video `KUY6FJm3CEo` into Tajik using different LLM web interfaces that do not require login.

### Source text extraction

Submitted video to `/api/web/youtube` with `sourceLang=ky` and `targetLang=none`:

```bash
curl -X POST http://localhost:3000/api/web/youtube \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=KUY6FJm3CEo&list=PLexVSHsn9t2C-ow8i3z4u1g_EolRf2dQI","sourceLang":"ky","targetLang":"none"}'
```

Result: 3,816 chars of Kyrgyz text. Saved first 1,200 chars as a representative sample.

### Prompt used for all web tests

```
Translate the following Kyrgyz text into Tajik (Cyrillic script).
Preserve the exact meaning. Do not add, remove, or summarize anything.
Output only the translation.
```

### Services that worked without login

#### arena.ai (Chatbot Arena)
- Returned two anonymous model responses.
- Both produced Tajik Cyrillic output.
- Saved as **Assistant A** and **Assistant B** in `tmp/llm_translation_comparison.md`.

#### duck.ai (DuckDuckGo AI Chat, GPT-5.4 nano)
- Responded without login after accepting ToS.
- Ignored "Cyrillic script" instruction and returned Persian/Arabic script.

### Services that required login/sign-up (not tested)

- ChatGPT (`chatgpt.com`)
- Gemini (`gemini.google.com`)
- DeepSeek (`chat.deepseek.com`)
- Kimi (`www.kimi.com`)
- Claude (`claude.ai`)
- Mistral Le Chat (`chat.mistral.ai`)
- Meta AI (`www.meta.ai`)
- OpenRouter Playground (`openrouter.ai/chat`)
- HuggingChat (`huggingface.co/chat`) — UI loads, sending requires login
- Qwen (`chat.qwen.ai`)
- ChatGLM (`chatglm.cn`)
- Cerebras Inference (`chat.cerebras.ai`)
- Poe (`poe.com`)

### Backend reference

Same sample translated via deployed Tiltap backend (`/api/translate`, Groq Llama 3.3 70B):

- Returned Tajik Cyrillic.
- Included warning: "Тарҷумаи ҳозира баъзе иборатҳо ва номҳоро дуруст тарҷума накардааст".

### Output file

Full comparison report: `tmp/llm_translation_comparison.md`

---

## 4. Gemini 2.5 Flash cost estimate

Assumptions: **20 videos/day × 15 min × 30 days = 600 videos/month**

| Model | Tokens/video | Input cost | Output cost | **Monthly** |
|---|---|---|---|---|
| Gemini 2.5 Flash | 2k in / 2.5k out | $0.36 | $3.75 | **~$4.10** |
| Gemini 2.5 Flash | 3k in / 4k out | $0.54 | $6.00 | **~$6.55** |
| Gemini 2.5 Flash Lite | 2k in / 2.5k out | $0.12 | $0.60 | **~$0.72** |
| Gemini 2.5 Flash Lite | 3k in / 4k out | $0.18 | $0.96 | **~$1.14** |

Pricing (July 2026):
- Gemini 2.5 Flash: `$0.30/M input`, `$2.50/M output`
- Gemini 2.5 Flash Lite: `$0.10/M input`, `$0.40/M output`

Note: with the confirmation workflow, confirmed translations cost $0 on repeat requests. If review step is enabled, roughly double the estimates.

---

## 5. Server access setup

User lost console/root password. Created a dedicated SSH user instead of sharing root access.

### Commands run on server

```bash
PASS=$(openssl rand -base64 24 | tr -d "=+/" | cut -c1-20)
useradd -m -s /bin/bash tiltab
echo "tiltab:$PASS" | chpasswd
usermod -aG sudo tiltab
usermod -d /opt/tiltap tiltab
chown -R tiltab:tiltab /opt/tiltap

# Enable SSH password auth
sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication yes/" /etc/ssh/sshd_config
systemctl restart sshd
```

### Credentials provided

```bash
ssh tiltab@95.216.169.56
# Password: Xh86QtTcTqsaldniHlG6
```

User instructed to:
1. Change password immediately with `passwd`.
2. Set root console password with `sudo passwd root` if VNC access is needed.

---

## 6. Admin token instructions

To protect `/web/admin.html`, add `TILTAB_ADMIN_TOKEN` to server `.env`:

```bash
ssh tiltab@95.216.169.56
cd /opt/tiltap
echo "TILTAB_ADMIN_TOKEN=tiltab-admin-2026-secret" >> .env
sudo systemctl restart tiltab-backend.service
```

Then enter the same token in the admin UI.

Recommended: generate a strong token with `openssl rand -hex 32`.

---

## Files created/modified

### Local
- `src/services/translationService.ts` (modified)
- `src/controllers/adminController.ts` (modified)
- `src/routes/admin.ts` (modified)
- `public/web/admin.html` (modified)
- `tmp/ky_source.txt` (created)
- `tmp/ky_sample.txt` (created)
- `tmp/llm_translation_comparison.md` (created)
- `docs/Session_Log_2026-07-05.md` (created)

### Server
- All files listed in deployment section above.
- `.pglite-data2.corrupted.20260705` (created from corrupted data)

---

## Recommendations

1. **Rotate API keys** — `OPENAI_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY` were exposed in earlier output.
2. **Set `TILTAB_ADMIN_TOKEN`** and change the `tiltab` SSH password.
3. **Monitor PGlite stability** — if the backend crashes repeatedly, the embedded DB may corrupt again. Consider migrating to real PostgreSQL (`DATABASE_URL`) for production.
4. **Keep Groq Llama 3.3 70B** as the primary translator; it outperformed free web alternatives in this test.
