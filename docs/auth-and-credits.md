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
  dev-simulated (grants Pro instantly). `POST /api/billing/portal` → Stripe billing
  portal (needs a recorded `stripeCustomerId`).
- **Webhook** (`POST /api/billing/webhook`, signature-verified) handles three events:
  - `checkout.session.completed` → first grant, length from the Plan_Catalog
    (`lifetime` → `proUntil: null`).
  - `invoice.paid` → every renewal. Sets `proUntil` to the end of the period the
    invoice paid for (invoice line `period.end`, else the subscription's
    `current_period_end`), so a retried delivery converges instead of granting
    another month. The account is found by `stripeCustomerId` (an invoice carries a
    customer id, not an address), falling back to the invoice's email the one time
    the id isn't linked yet.
  - `customer.subscription.deleted` → stop renewing, clamping `proUntil` down to the
    period already paid for (never up). A portal cancel is `cancel_at_period_end`, so
    the event arrives at the period end anyway; a non-payment cancel arrives weeks
    after it, so Pro is already gone.
  - `invoice.payment_failed` is deliberately unhandled: `proUntil` already ends with
    the paid period, and Stripe's retries either recover (`invoice.paid`) or end in a
    cancel. Every other event type is acknowledged with 200 so it isn't redelivered.
  - A store or Stripe failure mid-grant answers 500 so Stripe retries; the writes are
    idempotent, so a retry is safe.

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
- [x] Env and keys are all set on the serving revision, and `mail.snapgut.com` is the
      verified Resend sending domain (`EMAIL_FROM` = `SnapGut <notifications@mail.snapgut.com>`).
      See [docs/configuration.md](configuration.md) for the per-variable status.
- [x] Stripe webhook registered at `https://snapgut.com/api/billing/webhook`
      (`we_1TzOMpJdwajaewjQ8JxIR9Qf`, live mode), subscribed to exactly
      `checkout.session.completed`, `invoice.paid`, and `customer.subscription.deleted` —
      the three the handler acts on. The signing secret Stripe issued at registration is
      stored as `stripe-webhook-secret` and mounted as `STRIPE_WEBHOOK_SECRET`.
- [x] Recurring plans are handled in the webhook: `invoice.paid` extends `proUntil`
      to the period the invoice paid for, `customer.subscription.deleted` clamps it
      down to the period already paid for, both idempotent under redelivery. Covered
      by `src/billingWebhook.test.ts`. `invoice.payment_failed` is intentionally not
      handled (see above).
- [ ] Firestore: the renewal path queries `users` by `stripeCustomerId`. Equality on
      one field is served by the automatic single-field index, so nothing to create —
      but if single-field indexing is ever exempted for `users`, add an index for it,
      or renewals start failing (as 500s, so Stripe retries).
- [ ] Move `auth/request` rate-limit to the shared store for multi-instance.
- [ ] Client can let users log locally before sign-in (optional friction reduction).

## Client
- `AuthGate` (email → code), `Paywall` (three plans; dev-sim or Stripe redirect).
- Header shows **✨ N free** (tap → upgrade) or **✨ PRO**.
- `MealDetails`/`InsightsView` surface `402 → upgrade`, `401 → sign out`, and update
  entitlement from API responses. Free users reveal the AI insight on demand; Pro auto.
