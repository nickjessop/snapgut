# Auth & Credits — Design

Gate the app behind **email + verification**, give a few free credits, and sell more
via **Stripe**. AI actions (food recognition, insights) consume credits.

## Model
- **Email-only, passwordless.** Enter email → receive a 6-digit code (via Resend) →
  verify → you're in. No passwords.
- **Session:** stateless signed token (HMAC, `SESSION_SECRET`), stored client-side,
  sent as `Authorization: Bearer <token>`. ~30-day expiry.
- **Credits:** new accounts get `FREE_CREDITS` (default 5). Each AI call costs 1
  credit, deducted on success. At 0 → paywall to buy more.
- **Local logging stays free & offline** — only the AI endpoints require credits.

## Endpoints (server)
- `POST /api/auth/request { email }` → create + email a code (rate-limited). Dev:
  code is logged and returned so you can test without Resend.
- `POST /api/auth/verify { email, code }` → issue session token + `{ email, credits }`.
- `GET  /api/me` (auth) → `{ email, credits }`.
- `POST /api/billing/checkout { pack }` (auth) → Stripe Checkout URL. Dev: simulated.
- `POST /api/billing/webhook` → Stripe `checkout.session.completed` → add credits
  (raw-body signature verified with `STRIPE_WEBHOOK_SECRET`).
- `POST /api/recognize`, `POST /api/insights` — now require a valid session and ≥1
  credit; deduct on success.

## Datastore
Abstraction in `server/store.js`:
- **dev (default):** in-memory (resets on restart) — fine for local testing.
- **prod:** Firestore (`USERS_BACKEND=firestore`, uses ADC like Vertex). Collections:
  `users` (email, credits, createdAt), `authCodes` (hashed code + expiry).

## Env / config
| Var | Purpose |
| --- | --- |
| `SESSION_SECRET` | HMAC signing secret for session tokens |
| `RESEND_API_KEY`, `EMAIL_FROM` | send verification emails (else dev-logs the code) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | billing (else dev-simulated) |
| `USERS_BACKEND=firestore`, `GOOGLE_CLOUD_PROJECT` | persistent store (else in-memory) |
| `FREE_CREDITS` | starter credits (default 5) |

## Dev mode
With no Resend/Stripe/Firestore configured, the flow is fully testable:
- verification code is returned/logged instead of emailed,
- "buy credits" adds credits directly (simulated checkout),
- users/credits live in memory.

## Client
- `AuthGate`: email → code screens; stores token; shown until a valid session exists.
- Credits shown in the UI; AI failures with `402` open a **paywall** (buy packs).
- Session token attached to all `/api` calls; `401` clears session → back to AuthGate.

## Security notes
- Rate-limit `auth/request` per email/IP; codes expire (10 min), single-use, hashed.
- Never log tokens/secrets. Webhook verifies Stripe signature on the raw body.
- HTTPS only (Cloud Run). CORS same-origin.
