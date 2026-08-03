# ViewHunt ads + product telemetry

## What you get

Funnel: **Ad → Visit → Signup → Card trial → First cook → Paid**

| Question | Where to look |
|----------|----------------|
| Are ads working? | Meta/Google Ads Manager + admin funnel `by utm_source` |
| Where do people drop? | `/admin/dashboard` conversion rates |
| Spend more or fix? | If trial→cook is weak, fix product first. If cook→paid is healthy and volume is low, scale ads. |

## DigitalOcean env vars

```
ANALYTICS_PARTNER_START_DATE=2026-07-26
POSTHOG_KEY=<project API key>
POSTHOG_HOST=https://us.i.posthog.com
META_PIXEL_ID=<pixel id>
META_CAPI_TOKEN=<Conversions API access token>
META_CAPI_TEST_CODE=<Events Manager test code — temporary>
GOOGLE_ADS_ID=AW-XXXXXXXX
GOOGLE_ADS_LABEL_TRIAL=<conversion label for trial>
GOOGLE_ADS_LABEL_PAID=<conversion label for first payment>
```

## External setup (do once)

### 1. PostHog
1. Create a project at [posthog.com](https://posthog.com)
2. Copy **Project API key** → `POSTHOG_KEY`
3. Use US host `https://us.i.posthog.com` or EU if you chose EU

### 2. Meta
1. Events Manager → your Pixel → copy **Pixel ID** → `META_PIXEL_ID`
2. Settings → **Generate access token** (Conversions API) → `META_CAPI_TOKEN`
3. Test Events → copy **Test event code** → `META_CAPI_TEST_CODE` (remove after validation)

### 3. Google Ads
1. Create conversion actions:
   - `ViewHunt Trial Started` (primary)
   - `ViewHunt First Payment` (secondary)
2. Use the **tag / conversion label** values in `GOOGLE_ADS_ID` + `GOOGLE_ADS_LABEL_*`

### 4. Ad URL template

Always use UTMs:

```
https://viewhunt.app/?utm_source=meta&utm_medium=paid&utm_campaign=YOUR_CAMPAIGN&utm_content=CREATIVE_A
```

## Canonical events

| Event | Fired when |
|-------|------------|
| `landing_viewed` | `/` loaded |
| `signup_started` | Register modal opened |
| `signup_completed` | Account created |
| `ranking_opened` | `/studio/ranking` |
| `checkout_started` | Plan checkout session created |
| `trial_started` | Stripe status → `trialing` (**primary ad conversion**) |
| `ranking_assemble_started` | Assemble job accepted |
| `ranking_assemble_succeeded` | Ranking video finished |
| `trial_exhausted` | 3 videos or 7 days used up |
| `subscription_activated` | First paid / end-trial-early (**secondary**) |
| `subscription_canceled` | Stripe canceled |

## Validation checklist

After deploy + env vars:

1. Open `https://viewhunt.app/?utm_source=test&utm_campaign=validate`
2. Confirm browser Network → `/api/telemetry/config` returns your pixel/PostHog keys
3. Sign up a test account → PostHog shows `signup_completed`; Meta Test Events shows `CompleteRegistration`
4. Start a Stripe trial (test card) → `trial_started` / Meta `StartTrial` / Google trial conversion
5. Assemble a ranking video → `ranking_assemble_succeeded` in admin funnel after Refresh
6. End trial early or wait for paid → `subscription_activated` / Meta `Purchase`
7. Open `/admin/dashboard` → rates populate; remove `META_CAPI_TEST_CODE`

## Code map

- Client: `server/public/js/viewhunt-telemetry.js`
- Server: `server/lib/telemetry.js`
- Funnel API: `server/lib/admin-analytics.js` → `GET /api/admin/analytics`
- Dashboard: `server/public/admin/dashboard.html`
