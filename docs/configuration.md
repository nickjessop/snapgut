# Required configuration

Every environment variable the server reads, what it's for, and what happens without it.
Satisfies Requirement 18.1 in `.kiro/specs/marketing-site-and-routing/`.

Secrets live in Secret Manager and are injected into the Cloud Run revision. They must
never appear in the repository, the container image, or a deploy command line
(Requirement 18.5).

## Secrets

| Variable | Secret Manager entry | Purpose | If absent |
| --- | --- | --- | --- |
| `SESSION_SECRET` | `session-secret` | HMAC key for session tokens | **Refuses to boot in production.** Tokens would otherwise be forgeable |
| `RESEND_API_KEY` | `resend-api-key` ✅ stored | Sends the sign-in verification code | Falls back to logging the code to stdout — fine for dev, broken for real users |
| `STRIPE_SECRET_KEY` | `stripe-secret-key` | Checkout + billing portal | Billing runs in simulated mode: checkout grants Pro without payment. **Must be set before launch** |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook-secret` | Verifies webhook signatures | Webhook returns 400; entitlements never update from Stripe |
| `ADMIN_TOKEN` | `admin-token` | Guards `/api/admin/missing-foods` | Endpoint responds 404 — coverage telemetry unreadable |

## Non-secret configuration

| Variable | Production value | Purpose | If absent |
| --- | --- | --- | --- |
| `USERS_BACKEND` | `firestore` | Selects the datastore | **Silently falls back to an in-process map** — every account and Pro entitlement is lost on the next revision. Requirement 18.3 makes this a boot failure |
| `GOOGLE_CLOUD_PROJECT` | `REDACTED-GCP-PROJECT` | Vertex AI + Firestore project | Recognition and insights switch to mock mode |
| `FOOD_PACK_BUCKET` | `REDACTED-GCP-PROJECT-pack` | Bucket behind `/foods/*` | Defaults to the same name in code; thumbnails fall back to letter avatars if wrong |
| `VERTEX_LOCATION` | `us-central1` | Vertex region | Defaults to `us-central1` |
| `VERTEX_MODEL` | `gemini-2.5-flash-lite` | Recognition/insights model | Defaults to `gemini-2.5-flash-lite`. **Must stay a `publishers/google` model** — third-party models bill outside credits (Requirement 18.9) |
| `EMAIL_FROM` | `SnapGut <noreply@send.snapgut.com>` | Sender address | Defaults to `onboarding@resend.dev`, which only works for testing. Needs the verified sender domain before launch |
| `MOCK_AI` | unset | Forces mock recognition | Auto-enabled when `GOOGLE_CLOUD_PROJECT` is unset |
| `TRUSTED_PROXY` | `cloudflare` — ⚠️ **not implemented yet** | Which header to trust for client IP | Today `clientIp()` reads the leftmost `X-Forwarded-For`, which a client can spoof to reset its own rate limit once we're behind the edge. Requirement 14 / task 11.1 |
| `NODE_ENV` | `production` | Enables prod fail-fast + HSTS | Prod-only guards stay off |
| `FREE_AI_LIMIT` | unset (default 10) | Free AI uses per account | Defaults to 10 |
| `PORT` | set by Cloud Run | Listen port | Defaults to 8080 |

## Storing and rotating a secret

Pipe via stdin so the value never enters shell history or the process list. Keep it on
**one line** — a mangled line continuation creates the secret without its value:

```bash
# first time (creates the container and version 1)
printf '%s' 'VALUE' | gcloud secrets create NAME --project=REDACTED-GCP-PROJECT --replication-policy=automatic --data-file=-

# rotating (adds a new version; the old one stays until disabled)
printf '%s' 'VALUE' | gcloud secrets versions add NAME --project=REDACTED-GCP-PROJECT --data-file=-

# confirm a version exists — metadata only, never the value
gcloud secrets versions list NAME --project=REDACTED-GCP-PROJECT
```

## Local development

No `dotenv` dependency; Node 20 reads an env file natively. `.env` is gitignored.

```bash
node --env-file=.env server/index.js
```

Most local work needs **none** of the secrets: with `RESEND_API_KEY` unset the
verification code is logged to the console, and with no Stripe keys checkout is
simulated. Set them only when specifically testing email or billing.
