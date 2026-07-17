# Deploy: Fly Machines + DigitalOcean

DigitalOcean continues to host the Express app (API, Studio UI, auth, Stripe).
Fly Machines run ephemeral workers for ranking FFmpeg assembly and niche scraping.

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
FLY_ASSEMBLY_IMAGE=registry.fly.io/viewhunt-assembly:latest
FLY_SCRAPER_IMAGE=registry.fly.io/viewhunt-scraper:latest

# Durable video storage (AWS S3 or DigitalOcean Spaces)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET_NAME=
AWS_REGION=us-east-1
# Or Spaces:
# SPACES_KEY=
# SPACES_SECRET=
# SPACES_BUCKET=
# SPACES_REGION=nyc3
# SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com
# SPACES_CDN_URL=https://your-cdn.example.com

# Scraper / collector
YOUTUBE_API_KEY=
```

If Fly vars are missing, ranking assembly and niche scrapes fall back to in-process
FFmpeg / YouTube Data API on the DO app.

## Deploy Fly worker images

```bash
# One-time
fly apps create viewhunt-assembly
fly apps create viewhunt-scraper

# Build & push (from repo root)
fly deploy -c fly.assembly.toml --build-only --push
fly deploy -c fly.scraper.toml --build-only --push

# Machines are started on demand via the Machines API — no need for always-on VMs.
```

Set `FLY_ASSEMBLY_IMAGE` / `FLY_SCRAPER_IMAGE` to the image refs printed by Fly
(or `registry.fly.io/viewhunt-assembly:latest`).

## Trial behavior

New free users get `trial`: 3 days **or** 3 completed ranking videos (whichever first).
Ranking assemble during trial skips the ranking_assembly credit charge.
Other Studio formats still use the credit wallet.
Stripe checkout converts `trial.status` → `converted`.

## Admin triggers

```
POST /api/channels/niche-scrape          # start a scrape/rotation run
GET  /api/channels/niche-scrape/status   # recent runs
POST /api/channels/auto-collect          # legacy daily API collector
```

## Local smoke checks

```bash
cd server
node workers/smoke-test.js
```
