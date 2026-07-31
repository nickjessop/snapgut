# Auth & Monetization — Design

Gate the app behind **email + verification**, keep logging free, and monetize AI via
**SnapGut Pro** (freemium + subscription/lifetime). No per-action credits.

## Why entitlement, not credits
AI cost is negligible (~$0.0002/snap, ~$0.05/mo for a heavy user on Gemini
Flash-Lite), so metering per action only adds friction to the daily-logging habit
that creates value. Instead: **free tier + one Pro unlock that covers all AI.**

## Tiers
| | Free | **SnapGut Pro** |
| --- | --- | --- |
| Manual logging (meals/symptoms/bowel/stress) | ✅ | ✅ |
| On-device Patterns stats + Foods ranking | ✅ | ✅ |
| Backup / CSV export | ✅ | ✅ |
| AI meal recognition | trial (`FREE_AI_LIMIT`, default 10) | ✅ unlimited |
| AI insight narrative | reveal on demand (shares the free trial) | ✅ auto |

Free trial is a **shared counter** across snaps + insight generations, so multiple
AI surfaces don't need separate metering. One `pro` flag covers all AI (now and future).

## Plans (sold three ways; prices configurable)
- **Annual — $29.99/yr** (lead)
- **Monthly — $4.99/mo**
- **Lifetime — $79.99 one-time** (best-value; safe because marginal AI cost is ~$0.05/mo/user)

## Model / endpoints
- **Auth:** `POST /api/auth/request` (emails a 6-digit code; dev logs/returns it),
  `POST /api/auth/verify` → HMAC session token + entitlement. `GET /api/me`.
- **Entitlement:** user = `{ email, pro, proUntil, freeAiUsed, createdAt }`.
  `isPro` = `pro && (proUntil == null || proUntil > now)` (null = lifetime).
- **AI gating:** `/api/recognize` and `/api/insights` require a session; allowed if
  `pro || freeAiUsed < FREE_AI_LIMIT`; non-pro success increments `freeAiUsed`;
  otherwise `402 { error: "upgrade_required" }`. Responses include the current
  `entitlement`.
- **Billing:** `GET /api/billing/plans`; `POST /api/billing/checkout {plan}` →
  Stripe Checkout (`subscription` for annual/monthly, `payment` for lifetime), or
  dev-simulated (grants Pro instantly). `POST /api/billing/webhook` →
  `checkout.session.completed` grants Pro.

## Datastore
`server/store.js`: in-memory (dev) / **Firestore** (`USERS_BACKEND=firestore`, prod).
Rate limits + per-email throttle live in the store too, so they're shared across
Cloud Run instances. Firestore is serverless-friendly (no connection pool to
exhaust) and authenticates via Application Default Credentials — no long-lived
service key to manage — so it inherits the same GCP IAM story as Vertex AI and
Cloud Run.

## Env / config (prod)
See [docs/configuration.md](configuration.md) — the single inventory of every variable,
whether it is a secret, and what breaks without it. The entries this flow depends on are
`SESSION_SECRET`, `USERS_BACKEND`, `RESEND_API_KEY`, `EMAIL_FROM`, `FREE_AI_LIMIT`, and the
Stripe key, webhook secret, and `STRIPE_PRICE_*` ids.

## Dev mode
No external keys needed: code is logged/returned, purchases are simulated (grant Pro),
store is in-memory. Verified end-to-end: sign in → 10 free → snap consumes → buy
Lifetime → Pro.

## Prod TODO
- [ ] Set env/keys above; verified Resend sending domain.
- [ ] Register Stripe webhook at `/api/billing/webhook`.
- [ ] For recurring plans, handle `invoice.paid` (extend `proUntil`) and
      `customer.subscription.deleted` (revoke) in the webhook.
- [ ] Move `auth/request` rate-limit to the shared store for multi-instance.
- [ ] Client can let users log locally before sign-in (optional friction reduction).

## Client
- `AuthGate` (email → code), `Paywall` (three plans; dev-sim or Stripe redirect).
- Header shows **✨ N free** (tap → upgrade) or **✨ PRO**.
- `MealDetails`/`InsightsView` surface `402 → upgrade`, `401 → sign out`, and update
  entitlement from API responses. Free users reveal the AI insight on demand; Pro auto.
