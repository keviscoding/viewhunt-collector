# Deploy: Fly Machines + DigitalOcean

DigitalOcean continues to host the Express app (API, Studio UI, auth, Stripe).
Fly Machines run ephemeral workers for ranking compute (trim + commentary + FFmpeg)
and niche scraping.

## Environment variables (DigitalOcean App)

Add these to the DO app (in addition to existing Mongo/Stripe/etc.):

```
# Shared worker auth
WORKER_SECRET=<long-random-secret>

# Public app URL (used by workers to download clips / POST bulk channels)
APP_URL=https://your-app.ondigitalocean.app

# Fly Machines
FLY_API_TOKEN=<fly deploy token or org token>
FLY_ASSEMBLY_APP=viewhunt-assembly
FLY_SCRAPER_APP=viewhunt-scraper
FLY_ASSEMBLY_IMAGE=registry.fly.io/viewhunt-assembly:deployment-01KXV7CCA1XN5P7VX671RMNHJJ
# Fly is ON by default. Set FLY_ASSEMBLY_ENABLED=0 to force DigitalOcean-only assembly.
# If Fly is silent ~30s, DO still falls back locally.
# SPACES_* must be set or finishes show MIME errors (broken local URL).
FLY_SCRAPER_IMAGE=registry.fly.io/viewhunt-scraper:latest
# Max concurrent ranking Fly machines (extras wait in Mongo queue)
FLY_ASSEMBLY_MAX_CONCURRENT=3

# Durable video storage (DigitalOcean Spaces) — REQUIRED for Fly ranking downloads
# Without this, assemble finishes but the browser gets a broken MIME / missing file.
SPACES_KEY=
SPACES_SECRET=
SPACES_BUCKET=viewhunt-media
SPACES_REGION=sfo3
SPACES_ENDPOINT=https://sfo3.digitaloceanspaces.com
# Public files: https://viewhunt-media.sfo3.digitaloceanspaces.com/...
# Use a Spaces access key (not a DO personal API token). Bucket must allow public-read or CDN.

# Scraper / collector / ranking AI
YOUTUBE_API_KEY=
GEMINI_API_KEY=
APIFY_TOKEN=
OPENAI_API_KEY=
REPLICATE_API_TOKEN=
# REPLICATE_API_KEY=  (also accepted)
```

If Fly vars are missing, ranking assembly falls back to in-process FFmpeg on the DO app
(including trim from payload times).

**Ranking pipeline on Fly:** download clips → FFmpeg trim (in/out from Studio) →
Gemini commentary lines + TTS (OpenAI TTS fallback) → Whisper word timestamps →
FFmpeg assemble → Spaces upload. Pass `GEMINI_API_KEY` and `OPENAI_API_KEY` into the
assembly Machine (via DO env → `fly-machines.js`).

**Gemini billing:** Studio TTS uses `gemini-2.5-flash-preview-tts`. If Google AI Studio
has auto top-up / billing disabled, TTS fails. OpenAI TTS is used as fallback when
`OPENAI_API_KEY` is set.

## Deploy Fly worker images

```bash
# One-time
fly apps create viewhunt-assembly
fly apps create viewhunt-scraper

# Build & push only (from repo root) — do NOT full-deploy an always-on machine
fly deploy -c fly.assembly.toml --build-only --push
fly deploy -c fly.scraper.toml --build-only --push

# Machines are started on demand via the Machines API — no always-on VMs.
# If you accidentally full-deployed and see "Suspended / restarting too much",
# destroy idle machines: fly machines list -a viewhunt-assembly && fly machine destroy <id> --force
```

Set `FLY_ASSEMBLY_IMAGE` / `FLY_SCRAPER_IMAGE` to the image refs printed by Fly
(or `registry.fly.io/viewhunt-assembly:latest`).

**Required for heartbeats (all of these on DigitalOcean, then redeploy DO):**
1. `WORKER_SECRET` — random string you generate (`openssl rand -hex 32`)
2. `APP_URL=https://viewhunt.app` (clip URLs for browsers)
3. `APP_INTERNAL_URL=https://YOUR-APP.ondigitalocean.app` — **critical**  
   Copy from DigitalOcean App → Overview (default ingress). Fly callbacks/downloads
   should use this so Cloudflare on the custom domain does not hang Fly POSTs.
4. `FLY_ASSEMBLY_IMAGE=registry.fly.io/viewhunt-assembly:deployment-…` (full registry tag)
5. **Mongo Atlas → Network Access → allow `0.0.0.0/0`** (or Fly egress IPs).  
   If Atlas blocks Fly, the worker cannot load the job or write heartbeats.

`viewhunt-assembly` showing **Suspended / no machines** on Fly is normal when idle.

**Drafts / restarts:** Ranking projects autosave to Mongo (`ranking_drafts`). Fly
jobs are **not** cancelled when DigitalOcean restarts; reopen Studio to resume.

## Queue / concurrency

Studio editor (local DO) uses an in-memory one-at-a-time queue.
**Ranking on Fly** uses a Mongo-backed queue: up to `FLY_ASSEMBLY_MAX_CONCURRENT`
machines run at once (default 3); further jobs wait with a “Queued for Fly worker…”
message and start when a slot frees (on status poll / job complete).

## Ranking + AI commentary (on Fly)

Full ranking jobs — trim, Gemini hook/commentary, TTS, Whisper captions, FFmpeg —
run on **Fly Machines** (`viewhunt-assembly`). DigitalOcean enqueues the job and
serves clip uploads. The Studio UI only picks in/out points; it does not trim on DO.

## Burned-in text removal

POV captions, handles, and other hard-coded overlays can be removed via Replicate
`hjunior29/video-text-remover` — **opt-in per clip** after preview (or while trimming).
Requires on DigitalOcean:
- `REPLICATE_API_TOKEN` (preferred) or `REPLICATE_API_KEY` — token from
  https://replicate.com/account/api-tokens (starts with `r8_`, no quotes)
- `APP_URL=https://viewhunt.app` (so Replicate can fetch `/studio/ranking-uploads/...`)

Not run automatically on every import.

## Why Fly commentary felt stuck

Older builds uploaded **entire clips** to Gemini for every line, then tried Gemini TTS
(often failing) before OpenAI. That can sit on “generating commentary…” for many minutes.

Current worker: 2.5s low-res vision samples, OpenAI TTS first, Whisper timeout 12s,
progress messages per clip, 8GB assembly machines.

## Trial behavior

New free users get `trial`: 7 days **or** 3 completed ranking videos (whichever first).
Ranking assemble during trial skips the ranking_assembly credit charge.
Other Studio formats still use the credit wallet.
Starter / Creator / Studio Stripe checkout uses a 7-day `trial_period_days`.
Stripe checkout / `customer.subscription.created` converts app `trial.status` → `converted`.

## Admin triggers

```
POST /api/channels/niche-scrape          # start a scrape/rotation run
```
