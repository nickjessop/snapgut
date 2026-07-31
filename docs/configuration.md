# Configuration

The single inventory of every environment variable this project reads: what it is for,
whether it is a secret, and what happens when it is absent. Satisfies Requirements 18.1 and
18.6 in `.kiro/specs/marketing-site-and-routing/`. Other documents (`README.md`,
`docs/auth-and-credits.md`, `docs/security-and-infra-todo.md`) link here rather than
restating values.

Compiled by reading the code, not the previous version of this file: every `process.env.*`
in `server/`, `shared/`, and `scripts/`, and every `import.meta.env.*` in `src/`.

What the datastore `USERS_BACKEND` selects actually holds — every collection, its key, its
fields, whether it holds personal data, and what expires it — is in `docs/datastore.md`.

## How a value reaches the server

Non-secrets are plain environment variables on the Cloud Run revision. Secrets live in
Secret Manager and are injected as variables from a secret version; they must never appear
in the repository, the container image, or a deploy command line (Requirement 18.5). No
value is echoed into a response body, a log line, or an error message (Requirement 18.8).

Most variables are captured once at module import, so changing one needs a new revision.
`TRUSTED_PROXY` and `ADMIN_TOKEN` are read per request, and `STRIPE_PRICE_*` per checkout.

Secret Manager entry names are kebab-case except `SESSION_SECRET`, which predates the
convention; renaming a secret means creating a new one and re-entering the value, so it stays
as it is. `infra/secrets.ts` declares all five by name — a declared entry with no version is
not mounted on the revision, because mounting a versionless secret makes it fail to start.

## Failure classes

The consequence column below is the useful part of this table, and it is deliberately
asymmetric — see the design's runtime dependency map.

- **Fatal** — the server refuses to boot. Exactly two entries qualify: the session secret
  and the datastore selector. Nothing else is allowed to stop the service.
- **Degraded** — one named capability disappears or becomes unsafe. Every other route class
  keeps serving normally, so a missing Stripe key or Vertex project is a narrower product,
  not an outage. Degraded must never mean *permissive*: a missing Stripe key makes checkout
  refuse in production rather than fall back to the simulated grant, because a degraded
  capability that hands out Pro for free is worse than one that is unavailable.
- **Default** — a documented fallback applies with no user-visible loss.

## The inventory

`snapgut` = the deployed Cloud Run service (project `REDACTED-GCP-PROJECT`, `us-central1`), state
as of 2026-07-31 (serving revision `snapgut-00005-qfx`, verified). `infra/service.ts` and `infra/secrets.ts` are
the machine-readable form of that last column; this table is the explanation. Two gaps remain,
both in task 11: `EMAIL_FROM` (11.4) and `STRIPE_WEBHOOK_SECRET`, which Stripe only issues
when the endpoint is registered against the Canonical_Host (also 11.4).

| Variable | Secret | Class | Purpose | Consequence of absence | On `snapgut` |
| --- | --- | --- | --- | --- | --- |
| `SESSION_SECRET` | yes (entry `SESSION_SECRET`) | **Fatal** | HMAC key for session tokens (`server/auth.js`) | **Production refuses to boot** (`server/index.js`). Outside production it falls back to `dev-insecure-secret-change-me`, under which any token is forgeable | ✅ mounted from Secret Manager |
| `USERS_BACKEND` | no | **Fatal** | Selects the datastore for `server/store.js` **and** `server/eventStore.js`; only the exact value `firestore` selects Firestore | **Production refuses to boot** unless it is `firestore` — the guard in `server/index.js` mirrors the `SESSION_SECRET` one (Req 18.3). Without that guard anything else silently selects a per-process in-memory map: accounts, Pro entitlements, auth codes, rate limits, and queued sync events all vanish on the next revision — silent data loss, which is why this is fatal rather than degraded | ✅ `firestore` — checked on revision `snapgut-00005-qfx` 2026-07-31, not assumed from the guard's existence (task 11.1) |
| `GOOGLE_CLOUD_PROJECT` | no | Degraded | Vertex AI and Firestore project | Forces `MOCK_AI`: `/api/recognize` and `/api/insights` return fabricated data. Logging, trends, and every marketing route are unaffected | ✅ `REDACTED-GCP-PROJECT` |
| `VERTEX_LOCATION` | no | Default | Vertex region | Defaults to `us-central1`, matching the code default in `server/index.js` and in the generation scripts | ✅ `us-central1` — verified on the revision 2026-07-31 |
| `VERTEX_MODEL` | no | Default | Recognition and insights model | Defaults to `gemini-2.5-flash-lite`. **Must stay a `publishers/google` model** — a third-party model bills outside Google Cloud credits (Req 18.9). Asserted by `src/vertexModel.test.ts`; see [Cost guardrails](#cost-guardrails) | unset → code default (deliberately not set on the revision; confirmed 2026-07-31) |
| `MOCK_AI` | no | Default | `=1` forces mock recognition and insights | Off unless set; auto-enabled anyway when `GOOGLE_CLOUD_PROJECT` is unset | unset |
| `FOOD_PACK_BUCKET` | no | Default | Private bucket behind `/foods/*` | Defaults to `REDACTED-GCP-PROJECT-pack` in code. A wrong or unreadable bucket degrades thumbnails to letter avatars; no other route class is affected | ✅ `REDACTED-GCP-PROJECT-pack` |
| `RESEND_API_KEY` | yes (`resend-api-key`) | Degraded | Sends the sign-in verification code | `/api/auth/request` logs the code to stdout **and returns it in the response body**, so anyone can sign in as any address. Acceptable locally, an authentication bypass in production | ✅ mounted from Secret Manager |
| `EMAIL_FROM` | no | Degraded | Sender address | Defaults to `SnapGut <onboarding@resend.dev>`, which Resend only accepts for the account owner's own address — with a real API key set, every other sign-in email is rejected and `/api/auth/request` answers 500. Must be an address on the verified sending domain (`mail.snapgut.com`) | ❌ unset — task 11.4 sets `SnapGut <notifications@mail.snapgut.com>` |
| `STRIPE_SECRET_KEY` | yes (`stripe-secret-key`) | Degraded | Checkout and billing portal | **In production, checkout answers `billing_unavailable` 503 and grants nothing** — the simulated branch is gated on `NODE_ENV` in `server/index.js`, not merely on the key being mounted, because granting Pro without payment is worse than an unavailable upgrade. Outside production it still simulates and grants Pro immediately, which is what local work wants. The portal and webhook answer `billing_disabled` 400 | ✅ mounted from Secret Manager (`stripe-secret-key`, `latest`) — verified on revision `snapgut-00005-qfx` |
| `STRIPE_WEBHOOK_SECRET` | yes (`stripe-webhook-secret`) | Degraded | Verifies webhook signatures | Signature construction throws, the webhook answers `bad signature` 400, and entitlements never update from Stripe. **Now that `STRIPE_SECRET_KEY` is mounted this is the sharp edge**: a customer can complete a real Checkout and receive nothing, because `checkout.session.completed` is the only first-grant path. Stripe retries a failed delivery for ~3 days, so a grant can still land if the secret is set inside that window (task 11.4) | ❌ entry declared, no version, not mounted — waits on task 11.4, which is when Stripe issues it |
| `STRIPE_PRICE_MONTHLY` | no | Degraded | Price id for the monthly plan | Read via `PLANS.monthly.priceEnv` in `/api/billing/checkout`; unset sends `price: undefined` to Stripe, which rejects the call — the route has no handler for it, so the request ends as an unhandled 500. Other plans still work | ✅ `REDACTED-STRIPE-PRICE` (`infra/service.ts`, from the `stripePrices` stack config) |
| `STRIPE_PRICE_ANNUAL` | no | Degraded | Price id for the annual plan | Same as above for the annual plan (also the fallback plan when the request names an unknown one) | ✅ `REDACTED-STRIPE-PRICE` |
| `STRIPE_PRICE_LIFETIME` | no | Degraded | Price id for the lifetime plan | Same as above for the lifetime plan | ✅ `REDACTED-STRIPE-PRICE` |
| `ADMIN_TOKEN` | yes (`admin-token`) | Degraded | Guards `/api/admin/missing-foods`; also read by `scripts/missing-foods.mjs` | The endpoint is **inert**: it answers `not_configured` 404 rather than 401 (Req 18.7), so the Coverage_Tally is unreadable and the script prints nothing. No user-facing effect | ✅ mounted from Secret Manager (`admin-token`, `latest`) — verified on the revision |
| `TRUSTED_PROXY` | no | Degraded | Which header `server/clientIp.js` trusts for the Client_IP: `cloudflare` reads `CF-Connecting-IP`, `cloudrun` takes the second-from-right `X-Forwarded-For` entry, unset takes the rightmost | Unset takes the rightmost `X-Forwarded-For` entry — never client-controlled, so never spoofable, but behind an edge that entry is the same proxy address for everyone, collapsing the auth throttle and the per-IP sync limiter into one shared bucket. Set it to match what actually fronts the origin (Req 14.8) — and that is `cloudrun` **both** at the `run.app` host and behind the Google load balancer the Canonical_Host resolves to, because a Google front end appends the client address either way. The cutover does not change this value: Cloudflare drops to DNS-only (D13), so nothing writes `CF-Connecting-IP` and the `cloudflare` mode would find it empty and fall back to the rightmost entry — safe but one shared bucket for everyone. `cloudflare` only if a Cloudflare-proxied hostname is ever put back in front | ✅ `cloudrun` — verified on revision `snapgut-00005-qfx` 2026-07-31 (task 11.1) |
| `NODE_ENV` | no | Degraded | Marks a production revision | The production-only guards stay off: the `SESSION_SECRET` fail-fast, the `USERS_BACKEND` fail-fast, and HSTS. A production revision without it is the dangerous case, because the two fatal entries above stop being fatal | set to `production` by the image |
| `FREE_AI_LIMIT` | no | Default | Free AI actions per account before the paywall | Defaults to 10. A non-numeric value becomes `NaN`, and the `>=` comparison then never trips, so **free AI becomes unlimited**; an empty value becomes 0, paywalling every AI action. Set it to an integer or leave it unset | unset → 10 |
| `PORT` | no | Default | Listen port | Defaults to 8080; Cloud Run sets it | set by Cloud Run |

## Build-time and script-only variables

These never reach the running service. `VITE_*` values are **baked into the client bundle**
at build time and are readable by anyone who loads the app, so a secret must never be one.

| Variable | Read by | Purpose | Consequence of absence |
| --- | --- | --- | --- |
| `VITE_GOOGLE_CLIENT_ID` | `src/googleSheets.ts`, `src/syncSettings.ts` | Google OAuth client id enabling the Sheets destination | The Sheets destination reports disabled and its Settings controls are hidden. SnapGut Cloud sync is unaffected |
| `VITE_MEALDB_FALLBACK` | `src/foodImages.ts` | `=1` enables the legacy TheMealDB thumbnail fallback | Off unless set, which is what production needs — it is a third-party origin |
| `TEXT_MODEL`, `IMAGE_MODEL` | `scripts/gen-food-*.mjs` | Generation models for the food list, dictionary, and pack images | Default to `gemini-2.5-flash` and `gemini-2.5-flash-image`. Same `publishers/google` rule as `VERTEX_MODEL` |
| `THUMB_PX`, `WHITE_TOLERANCE` | `scripts/gen-food-images.mjs` | Thumbnail size and background-removal tolerance | Default to 256 and 26 |
| `GCLOUD_PROJECT` | `scripts/gen-food-images.mjs` | Alternate project source | Falls back to `GOOGLE_CLOUD_PROJECT`, then to the ADC project |
| `BASE` | `scripts/missing-foods.mjs` | Origin the coverage report queries | Defaults to `http://localhost:8080` |

The generation scripts also read `VERTEX_LOCATION` and `GOOGLE_CLOUD_PROJECT`, and
`scripts/missing-foods.mjs` reads `ADMIN_TOKEN` while `scripts/stripe-setup-test.mjs` needs a
**test-mode** `STRIPE_SECRET_KEY` — the same variables as above, supplied to the script rather
than to the service.

## Cost guardrails

Two separate things, and only one of them is enforced.

### The model rule (enforced)

**Every configured model identifier must be a model published by Google
(`publishers/google`).** A model from any other publisher on Vertex AI bills as a Cloud
Marketplace charge, which sits *outside* committed credits — so a one-word change to
`VERTEX_MODEL`, `TEXT_MODEL`, or `IMAGE_MODEL` can move real spend off the credits paying for
this project. That is the whole reason the rule exists (Reqs 18.9, 21.6).

The three configuration points and their defaults:

| Variable | Where | Default | Set on the revision? |
| --- | --- | --- | --- |
| `VERTEX_MODEL` | `server/index.js` — recognition and insights | `gemini-2.5-flash-lite` | No — deliberately unset, so the code default applies |
| `TEXT_MODEL` | `scripts/gen-food-list.mjs`, `scripts/gen-food-dict.mjs` | `gemini-2.5-flash` | n/a (script-only, never reaches the service) |
| `IMAGE_MODEL` | `scripts/gen-food-images.mjs` | `gemini-2.5-flash-image` | n/a (script-only) |

`src/vertexModel.test.ts` fails the build if any of those defaults, or any `*MODEL` variable
set in `infra/service.ts`, is not first-party. It checks two things: that the identifier is a
**bare** model id (no `/`, no `:`) and that it starts with a known Google family prefix
(`gemini-`, `imagen-`, `veo-`, `gemma-`, the embedding families). The structural half is the
strong half — `@google-cloud/vertexai` expands a bare name to
`.../publishers/google/models/<name>`, and the generation scripts interpolate the value into a
hardcoded `publishers/google/models/${MODEL}` URL that a value containing `/` could climb out
of. The family prefixes are prefixes rather than exact strings on purpose, so a legitimate
version bump inside a Google family does not require a test edit.

### The budget alert (notifies only, does **not** cap)

Declared in `infra/budget.ts` and imported into Pulumi state (it was created by hand when
image generation started spending). Verified against the billing account on 2026-07-31:

```
$ gcloud billing budgets describe REDACTED-BUDGET-ID \
    --billing-account=REDACTED-BILLING-ACCOUNT
amount:
  specifiedAmount:
    currencyCode: CAD
    units: '200'
budgetFilter:
  calendarPeriod: MONTH
  creditTypesTreatment: INCLUDE_ALL_CREDITS
  projects:
  - projects/REDACTED-GCP-PROJECT-NUMBER
displayName: SnapGut food-image pack cap
notificationsRule: {}
thresholdRules:
- spendBasis: CURRENT_SPEND
  thresholdPercent: 0.25
- spendBasis: CURRENT_SPEND
  thresholdPercent: 0.5
- spendBasis: CURRENT_SPEND
  thresholdPercent: 0.9
- spendBasis: CURRENT_SPEND
  thresholdPercent: 1.0
```

So: **200 CAD per calendar month**, scoped to this project only (by project *number*,
`REDACTED-GCP-PROJECT-NUMBER`), all credits included in the spend it measures, with alerts at 25%, 50%, 90%,
and 100% of actual current spend. `notificationsRule: {}` means no Pub/Sub topic and no
monitoring channel are attached, so the alert email goes to the billing account's
administrators and users — nothing else receives it. The name reads "pack cap", which is
misleading; it caps nothing.

**A Google Cloud budget alert notifies; it does not cap.** Crossing 100% sends mail and the
meter keeps running. There is no setting anywhere in Cloud Billing that stops spend at a
number.

A real cap would have to be built: route the budget's notifications to a Pub/Sub topic, and
have a subscriber (a Cloud Function or Cloud Run job) act on the threshold message — either
detaching the billing account from the project, which stops every billable resource including
the live service, or disabling the Vertex AI API to shed just the AI spend. Both are blunt and
neither is in place; the second is the one worth building if we ever want it, because the first
takes the site down.

What actually bounds spend today, all of it in the application rather than in billing:

- `maxInstanceCount: 100` on the Cloud Run service (`infra/service.ts`) — the ceiling on
  concurrent compute.
- `FREE_AI_LIMIT` (default 10) — free AI actions per account before the paywall, so an
  anonymous flood cannot run up Vertex charges without paying.
- The per-IP rate limiters on auth and sync (`server/clientIp.js` and callers).
- Vertex AI's own per-project quotas, which cap request rate rather than dollars.

## Stripe catalog (live mode)

Created 2026-07-30 on the SnapGut account `REDACTED-STRIPE-ACCOUNT` (REDACTED-ENTITY,
country CA, `default_currency: usd`). One product, three prices, **all USD**, matching
`shared/plans.js` exactly. Price IDs are configuration, not secrets.

| Plan | Price id | Amount | Type |
| --- | --- | --- | --- |
| Monthly | `REDACTED-STRIPE-PRICE` | 499 | recurring / month |
| Annual | `REDACTED-STRIPE-PRICE` | 2999 | recurring / year |
| Lifetime | `REDACTED-STRIPE-PRICE` | 7999 | one-time |

Product: `REDACTED-STRIPE-PRODUCT` — "SnapGut Pro", `statement_descriptor: SNAPGUT`.

**Currency is immutable on a Price.** Changing to CAD later means creating new prices and
migrating any existing subscribers, so the pricing page must always state USD explicitly.

**These are live-mode objects.** Test mode is a separate object space with its own keys and
its own price ids. Without `STRIPE_SECRET_KEY` the server simulates checkout and grants Pro
without payment outside production; in production that branch is closed by the `NODE_ENV`
gate in `server/index.js` and the route answers 503 instead.

### Test-mode catalog for local development

```bash
# Key from Dashboard → Developers → API keys, with the Test mode toggle ON
STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup-test.mjs --dry-run
STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup-test.mjs
```

The script builds the product and all three prices from `shared/plans.js`, so a test price
can't drift from what the app charges. It is idempotent (prices are matched by
`lookup_key`), and because Stripe prices are immutable it archives and replaces a price
whose amount no longer matches the catalog. It **refuses to run against a live key**, since
that would add duplicates to the real catalog.

It prints the `STRIPE_PRICE_*` values to put in `.env`. To exercise entitlement updates you
also need the webhook:

```bash
stripe listen --forward-to localhost:8080/api/billing/webhook
# put the printed whsec_… into STRIPE_WEBHOOK_SECRET
```

Test card `4242 4242 4242 4242`, any future expiry, any CVC.

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

Most local work needs **none** of the secrets: with `RESEND_API_KEY` unset the verification
code comes back in the sign-in response, and with no Stripe keys checkout is simulated. Set
them only when specifically testing email or billing. Leave `USERS_BACKEND` unset locally —
the in-memory store is the point there; it is only a production hazard.
