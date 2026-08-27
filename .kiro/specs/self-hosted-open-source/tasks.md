# Implementation Plan: Self-Hosted Open-Source Conversion

## Overview

Six stages, in order, each leaving the test suite green and the server startable. Stage 1 is the largest diff (billing + telemetry + Sheets removal) but is entirely subtraction. Stages 2–5 each add one subsystem and can be reviewed independently. Stage 6 ties it together with the boot restructuring, deployment packaging, and documentation.

Total: 42 tasks across 6 stages. Dependencies are strictly sequential between stages; within each stage, tasks are ordered by dependency but many are parallelisable.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "name": "Stage 1: Remove Billing and Ungate Every Feature",
      "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9"],
      "dependencies": {
        "1.2": ["1.1"],
        "1.3": ["1.1"],
        "1.4": ["1.1"],
        "1.5": ["1.1"],
        "1.6": ["1.1"],
        "1.7": ["1.2", "1.3", "1.4", "1.5", "1.6"],
        "1.8": ["1.7"],
        "1.9": ["1.8"]
      }
    },
    {
      "name": "Stage 2: Persistent Local Datastore Backend",
      "tasks": ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.9"],
      "dependencies": {
        "2.2": ["2.1"],
        "2.3": ["2.1"],
        "2.4": ["2.2", "2.3"],
        "2.5": ["2.4"],
        "2.6": ["2.2", "2.3"],
        "2.7": ["2.2"],
        "2.8": ["2.3"],
        "2.9": ["2.5"]
      }
    },
    {
      "name": "Stage 3: Pluggable AI Provider",
      "tasks": ["3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8"],
      "dependencies": {
        "3.2": ["3.1"],
        "3.3": ["3.1"],
        "3.4": ["3.1"],
        "3.5": ["3.1"],
        "3.6": ["3.2", "3.3", "3.4", "3.5"],
        "3.7": ["3.6"],
        "3.8": ["3.6"]
      }
    },
    {
      "name": "Stage 4: Local Food Illustration Pack",
      "tasks": ["4.1", "4.2", "4.3", "4.4"],
      "dependencies": {
        "4.2": ["4.1"],
        "4.3": ["4.2"],
        "4.4": ["4.2"]
      }
    },
    {
      "name": "Stage 5: Single-User Auth and Secret Bootstrap",
      "tasks": ["5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "5.9"],
      "dependencies": {
        "5.2": ["5.1"],
        "5.3": ["5.1"],
        "5.4": ["5.3"],
        "5.5": ["5.2"],
        "5.6": ["5.3"],
        "5.7": ["5.1"],
        "5.8": ["5.5", "5.6"],
        "5.9": ["5.3"]
      }
    },
    {
      "name": "Stage 6: Packaging, Origin, Docs, and Deployment",
      "tasks": ["6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "6.8", "6.9", "6.10", "6.11", "6.12"],
      "dependencies": {
        "6.2": ["6.1"],
        "6.3": ["6.2"],
        "6.4": ["6.3"],
        "6.5": ["6.3"],
        "6.6": ["6.4", "6.5"],
        "6.7": ["6.6"],
        "6.8": ["6.6"],
        "6.9": ["6.7", "6.8"],
        "6.10": ["6.4"],
        "6.11": ["6.4"],
        "6.12": ["6.9", "6.11"]
      }
    }
  ]
}
```

## Tasks

### Stage 1: Remove Billing and Ungate Every Feature

- [x] 1.1 Make `isPro()` return `true` unconditionally in `server/store.js`. Delete or rewrite every test assertion expecting a not-entitled, quota-exhausted, or payment-required (402) outcome across all test files (`syncRoutes.test.ts`, `syncRoutes.privacy.test.ts`, `cloudSync.failure.test.ts`, `cloudSync.oneshot.test.ts`, `cloudSync.scheduler.test.ts`, `cloudSync.state.test.ts`, `app.startup.test.tsx`, `routing.client.test.tsx`, `deferredSignIn.test.tsx`, `settings.cloud.test.tsx`, `settings.delete.test.tsx`, `ui.wiring.test.tsx`, `syncSettings.persistence.test.ts`, `syncSettings.nudge.test.ts`). Run the full test suite and confirm it passes before proceeding.
  Requirements: 1.4, 1.5, 1.6, 1.13, 13.1, 13.2, 13.3

- [x] 1.2 Delete the Stripe billing routes and helpers from `server/index.js`: `STRIPE_SECRET` (line 39), `SIMULATE_CHECKOUT` block (59-77), `getStripe()` (205-212), `proUntilFor` and the entire billing section (620-888, covering `GET /api/billing/plans`, `POST /api/billing/checkout`, `POST /api/billing/portal`, the webhook helpers, and `POST /api/billing/webhook`). Delete `POST /api/admin/comp` (~1010). Delete `shared/plans.js`, `shared/plans.d.ts`, `scripts/stripe-setup-test.mjs`, `scripts/stripe-api.sh`. Remove the `stripe` dependency from `package.json`.
  Requirements: 1.1, 1.2, 1.10, 1.11

- [x] 1.3 Remove the 402 entitlement gates from `server/index.js`: the `isPro`/`FREE_AI_LIMIT` check and `incFreeAi` call at `/api/recognize` (lines 324-326, 363), the identical gate at `/api/insights` (448-450, 474). Remove the `entitlement` field from recognize and insight responses. Remove the entitlement gate (step 6) from `server/sync.js` along with `proExempt()` and the `entitlement` field from every sync response. Thread `now` through the `countFor`, `push`, and `pull` calls in `sync.js` while editing it.
  Requirements: 1.4, 1.5, 1.6, 1.7, 1.14, 12.7

- [x] 1.4 Strip entitlement from the store: remove `pro`, `proUntil`, `freeAiUsed`, `stripeCustomerId`, `comp` from `newUser()` in `server/store.js`. Delete `isPro`, `entitlement`, `FREE_AI_LIMIT`, `setPro`, `setComp`, `incFreeAi`, `getUserByStripeCustomerId` from both the memory and Firestore backends. Add an optional `now` parameter to `upsertUser` and `recordMissingFood`.
  Requirements: 1.8, 3.10

- [x] 1.5 Remove telemetry: delete the aggregate counter middleware and `POST /api/metrics` from `server/index.js` (lines 127-193). Delete `GET /api/admin/metrics` and `GET /api/admin/missing-foods` routes. Delete `incMetric`, `listMetrics`, `touchUser`, `userStats` from both store backends. Remove the `touchUser` call from `/api/me`. Delete `src/metrics.ts` and its single import/call in `src/App.tsx:31,341`.
  Requirements: 11.3, 11.4, 11.7, 11.8

- [x] 1.6 Remove Google Sheets sync: delete `src/googleSheets.ts` and all fourteen `src/googleSheets.*.test.ts` files. Remove the `"sheets"` destination from `src/syncSettings.ts` (collapse `DestinationId` to `"cloud"`, remove `isSheetsConfigured`, `SHEETS_SPREADSHEET_ID_KEY`, and the sheets entry from `describeDestinations()`). Remove the Sheets imports and wiring in `src/App.tsx` (`isSheetsConnected`, `syncAll` call) and `src/SettingsView.tsx` (the entire Sheets settings block and all Sheets-related imports). Remove `VITE_GOOGLE_CLIENT_ID` from build configuration.
  Requirements: 11.1, 11.6, 11.9

- [x] 1.7 Remove the client paywall and entitlement surface: delete `src/Paywall.tsx`. In `src/session.ts`, remove `Entitlement`, `Plan`, `fetchPlans`, `checkout`, `openPortal`; simplify `Me` to `{ email }`. In `src/api.ts`, remove `UpgradeRequiredError` and the `status === 402` branch; stop returning `entitlement` from `recognizeMeal` and `getInsights`. In `src/App.tsx`, remove the `ent` state, `paywall` state, `applyEnt` function, `paywallEl`, and every `entitlement`/`onUpgrade`/`onNeedUpgrade` prop pass. In `src/HeaderStats.tsx`, remove the free-AI pill and PRO badge (keep the streak chip). In `src/MealDetails.tsx`, remove `hasAiQuota`/`UpgradeRequiredError` branch/upgrade CTA. In `src/InsightsView.tsx`, remove the pro/freeLeft/upgrade path. In `src/SettingsView.tsx`, remove Plan row, Free-AI-left row, billing-portal button, `openPortal` call, `proEntitled`/`applyEntitlement` usage, and the Sheets block already handled. In `src/cloudSync.ts`, remove `applyResponseEntitlement`, `upgrade_required` failure kind, 402 branch, `pro: isProEntitled()` in reported state, and the `isProEntitled()` conjunct in the trigger gate. In `src/syncSettings.ts`, remove `EntitlementSnapshot`, `ENTITLEMENT_KEY`, `applyEntitlement`, `getEntitlementSnapshot`, `isProEntitled`; remove `entitled` from `DestinationActivity` and update `isDestinationActive` to `enabled && configured && !failing`.
  Requirements: 1.9, 1.15, 1.16, 11.9, 12.2

- [x] 1.8 Remove the pricing page and update the Route_Table: remove the `/pricing` entry from `MARKETING_PAGES` in `shared/site.js`. Delete `marketing/pricing.html`. Delete `vite/pricing.js` and its registration in `vite.config.ts`. Update the `marketingInputs()` helper to not include pricing. Rewrite `marketing/terms.html` to describe self-hosted use. Update all affected test fixtures and assertions that reference `/pricing` across: `src/routes.test.ts`, `src/routes.property.test.ts`, `src/serverRouteResolution.test.ts`, `src/serverRoutes.property.test.ts`, `src/pwa.offline.test.ts`, `src/pwa.property.test.ts`, `src/sanitizeNext.property.test.ts`, `src/site.table.test.ts`, `src/devRoutes.test.ts`, `src/marketing.build.test.ts`, `src/marketing.claims.test.ts`, `src/marketing.isolation.test.ts`, `src/marketing.metadata.test.ts`, `src/marketingCsp.test.ts`, `src/robotsSitemap.test.ts`, `src/serverRoutes.test.ts`.
  Requirements: 1.10, 1.12, 1.13

- [x] 1.9 Delete the remaining billing-specific test files: `src/billingCheckoutGuard.test.ts`, `src/billingPriceEnv.test.ts`, `src/billingWebhook.test.ts`, `src/comp.test.ts`, `src/plans.catalog.test.ts`, `src/pricing.plugin.test.ts`, `src/vertexModel.test.ts`, `src/metrics.server.test.ts`, `src/partials.test.ts`. Run the full test suite and confirm zero failures.
  Requirements: 1.13, 11.6, 13.3

## Stage 2: Persistent Local Datastore Backend

- [x] 2.1 Create `server/sqlite/schema.js` with the v1 schema (tables: `schema_meta`, `users`, `rate_limits`, `missing_foods`, `sync_meta`, `events` with all indexes), a `migrate(db)` function that applies pending migrations inside transactions, and reads `schema_meta.version` to decide what to run.
  Requirements: 2.4, 10.11

- [x] 2.2 Implement `createSqliteStore(db)` in `server/sqlite/store.js` — the Datastore_Backend surface against the SQLite schema: `getUser`, `upsertUser(email, now?)`, `deleteUser`, `rateLimit(key, max, windowMs, now?)`, `recordMissingFood(slug, reason, now?)`, `listMissingFoods(limit)`. Implement the fixed-window rate-limit with piggybacked expiry sweep (delete rows whose `expires_at < now - 2*windowMs`). All methods are `async` for signature parity.
  Requirements: 2.1, 2.2, 2.12, 3.6

- [x] 2.3 Implement `createSqliteEventStore(db)` in `server/sqlite/eventStore.js` — the Event_Store_Backend surface: `push(email, records, now?)`, `pull(email, cursor, limit, now?)`, `deleteAll(email)`, `countFor(email, now?)`, `getMeta(email)`. Use `BEGIN IMMEDIATE` transactions for push. Use the shared `planPush` planner. Implement the indexed tombstone sweep on pull and countFor. Store the whole record as JSON in the `record` column with denormalised `deleted` and `updated_at`.
  Requirements: 2.2, 2.3, 2.5

- [x] 2.4 Delete the Firestore backends: remove `firestoreStore()` and the `@google-cloud/firestore` import from `server/store.js`; remove `createFirestoreEventStore`, `firestoreEventStore`, and the Firestore-specific `assertPathSegment` from `server/eventStore.js`. Remove `@google-cloud/firestore` from `package.json`. Change the backend switch from `"firestore" | "memory"` to `"sqlite" | "memory"`, defaulting to `"sqlite"`. Remove the existing prod boot guard that required `USERS_BACKEND === "firestore"` in `server/index.js`. Add a guard that rejects any unrecognised `DATASTORE_BACKEND` value with a logged message and exit(1).
  Requirements: 2.1, 2.10, 2.11 (Decision D1)

- [x] 2.5 Add a boot-time warning when `DATASTORE_BACKEND` is `memory` and the bind host is exposed (not loopback). Implement the `DB_PATH` default resolving to `/data/snapgut.db`. Ensure parent directory creation on first open. Fail with a logged path and error on an unopenable file.
  Requirements: 2.6, 2.8, 2.9

- [x] 2.6 Write `src/sqlite.schema.test.ts`: migration from empty creates all tables; re-running `migrate` on an already-v1 database is a no-op. Write `src/sqlite.durability.test.ts`: open a temp db, push records, close it, reopen from the same path, confirm all data including `sync_meta.seq`, `sync_meta.epoch`, `events` records, and `rate_limits` rows survive.
  Requirements: 2.4, 2.5, 3.12

- [x] 2.7 Write `src/datastore.equivalence.test.ts`: property-based tests (fast-check, 200 runs, 30s timeout) comparing `createSqliteStore` against the memory store for sequences of 1–200 calls. Implement the `canon()` equality relation (key-sorted JSON, clock tolerance, slug tie-break, housekeeping excluded). Cover the `rateLimit` fixed-window boundary separately per Property 6.
  Requirements: 3.1, 3.6, 3.8, 3.10, 3.12

- [x] 2.8 Write `src/eventStore.equivalence.test.ts`: property-based tests comparing `createSqliteEventStore` against the memory event store. Cover Properties 2–5, 7–9, and 12 from the design. Use injected `now` advancing by `{0, 1ms, 1s, 1d, 180d}`. Confirm cursor pagination, sequence monotonicity, deleteAll idempotence, unknown-field round trip, and exception parity.
  Requirements: 3.2, 3.3, 3.4, 3.5, 3.7, 3.9, 3.11, 3.12

- [x] 2.9 Update `src/bootGuards.test.ts` to assert the new guard behaviour: unrecognised `DATASTORE_BACKEND` exits 1 with the supplied value and the accepted set logged; memory + exposed bind logs a warning; default is `sqlite`. Rewrite `src/rateLimitExpiry.test.ts` to test the SQLite sweep rather than a Firestore TTL. Run full suite green.
  Requirements: 2.8, 2.11, 2.12, 13.3

## Stage 3: Pluggable AI Provider

- [x] 3.1 Create `server/ai/index.js` with `createAiProvider(config)` that selects from `ollama`, `openai`, `gemini`, `mock` based on `config.ai.provider`. On an unrecognised value or a missing required setting, throw a `ConfigError`. Export the `AiProvider` and `AiRequest` type definitions.
  Requirements: 4.1, 4.14

- [x] 3.2 Implement `server/ai/ollama.js`: adapter that calls `POST {baseUrl}/api/generate` with `model`, `prompt`, `images: [base64]`, `format: "json"`, and the abort signal. Return `response` text.
  Requirements: 4.2, 4.6, 4.8

- [x] 3.3 Implement `server/ai/openai.js`: adapter that calls `POST {baseUrl}/v1/chat/completions` with the chat messages format (system + user with `image_url` for the image), `response_format: {type:"json_object"}`, model, and abort signal. Extract `choices[0].message.content`.
  Requirements: 4.3, 4.8

- [x] 3.4 Implement `server/ai/gemini.js`: adapter that calls the Gemini REST endpoint using an API key (no ADC). Send `inlineData` for the image, `generationConfig.responseMimeType: "application/json"`. Extract `candidates[0].content.parts[0].text`.
  Requirements: 4.4, 4.11

- [x] 3.5 Implement `server/ai/mock.js`: returns synthetic output within 1000ms with no network call. Recognition: a random mock meal from the existing `MOCK_MEALS` array. Insights: the existing `mockInsight` logic. Preserve both in the adapter.
  Requirements: 4.5

- [x] 3.6 Replace `getModel()` and the Vertex AI usage in `server/index.js` with calls to the AI provider: refactor `/api/recognize` and `/api/insights` to call `deps.ai.generate({ prompt, image, json: true, signal })`. Keep `sanitizeMeal` and the insight parse at the call sites — do not move them into the adapter. Apply `AbortSignal.timeout(config.ai.timeoutMs)`. Log only provider name, request kind, outcome, and elapsed ms.
  Requirements: 4.7, 4.9, 4.10, 4.13, 4.15, 4.16

- [x] 3.7 Remove the `@google-cloud/vertexai` dependency from `package.json`. Remove `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION`, `VERTEX_MODEL` env var reads. Remove the `MOCK_AI` flag — the mock provider replaces it. Remove `src/vertexModel.test.ts` (already deleted in 1.9 if not yet).
  Requirements: 4.11, 4.12

- [x] 3.8 Write `src/ai.adapters.test.ts`: for each provider, stub `global.fetch` and assert the request shape (URL, headers, body structure including image and JSON-mode fields). Write `src/ai.timeout.test.ts`: assert a slow fetch is aborted at the configured timeout. Write `src/ai.malformed.test.ts`: assert non-JSON model output for recognize yields `{ dish: "Meal", ingredients: [] }` with annotation still applied, and for insights yields `{ headline: "Insight", body: <raw text> }`. Write `src/ai.logging.test.ts`: capture console output and assert no prompt text, no image bytes, no diary content appear.
  Requirements: 4.9, 4.10, 4.13, 4.15, 4.16, 13.3

## Stage 4: Local Food Illustration Pack

- [x] 4.1 Create `server/foodPack.js` with `readPackFile(dir, name)` and `surveyPack(dir)`. `readPackFile` validates the pattern (`^[a-z0-9-]+\.webp$`, ≤128 chars), reads the file from the directory, and returns a result object. `surveyPack` counts files and checks for symlinks at boot.
  Requirements: 5.1, 5.2, 5.3, 5.4

- [x] 4.2 Replace the GCS food pack handler in `server/index.js` (lines 900-940): remove `FOOD_PACK_BUCKET`, `getFoodBucket()`, and the GCS streaming logic. Replace with a handler that calls `readPackFile`, responds 404 on pattern miss or missing file, 502 on unreadable file, and sets `Content-Type: image/webp` + `Cache-Control: public, max-age=31536000, immutable` on success. Keep the `recordMissingFood` tally with the `lookupSlug` guard. Remove `@google-cloud/storage` from `package.json`.
  Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.11, 5.13, 5.15

- [x] 4.3 Create `scripts/fetch-food-pack.mjs`: downloads the release archive to a temp file, verifies its SHA-256 against the published checksum, extracts into `FOOD_PACK_DIR` only after the checksum matches, skips files already present, leaves the directory unchanged on any failure, and exits non-zero with a descriptive message on timeout (600s), stall (60s), checksum mismatch, or extraction error.
  Requirements: 5.7, 5.8, 5.9, 5.14

- [x] 4.4 Write `src/foodPack.serve.test.ts`: pattern miss (404, no cache header, no file read), valid file (200, webp type, immutable cache), missing file (404), unreadable file (502 logged without file bytes), traversal attempts (path separators, `..`, percent-encoded, null bytes all 404). Write `src/fetchFoodPack.test.ts`: checksum mismatch leaves the directory unchanged; re-run with existing files is idempotent.
  Requirements: 5.2, 5.3, 5.4, 5.9, 5.13, 5.14, 13.3

## Stage 5: Single-User Auth and Secret Bootstrap

- [x] 5.1 Refactor `server/auth.js`: make `signToken(email, secret)` and `verifyToken(token, secret)` take the secret as a parameter instead of reading from module scope. Remove `generateCode`, `hashCode`, and `safeEqualHex`. Add `credentialMatches(submitted, expected, secret)` using HMAC-then-timingSafeEqual for constant-time comparison independent of length.
  Requirements: 6.3, 6.5, 6.16

- [x] 5.2 Create `server/secret.js` with `resolveSessionSecret(config)`: if `SESSION_SECRET` is set and ≥32 chars, use it; if set and <32, throw. If unset, read `${DATA_DIR}/session-secret`; if absent, generate 32 bytes with `crypto.randomBytes`, write with mode 0o600, log the path. Never log the value.
  Requirements: 7.1, 7.2, 7.3, 7.14

- [x] 5.3 Replace the auth routes in `server/index.js`: remove `POST /api/auth/request` and `POST /api/auth/verify`. Add `POST /api/auth/signin` that reads `{ password }`, checks `credentialMatches`, and on success calls `signToken` with `config.auth.email` as the identifier. Return the same `{ token, email }` shape. Rate-limit at 20/60s per address. On mismatch, missing, empty, >256 chars, or unconfigured credential: identical 401 + `{ error: "signin_failed" }`. Remove `server/email.js` and the `resend` dependency from `package.json`.
  Requirements: 6.1, 6.2, 6.4, 6.8, 6.10, 6.12, 6.13, 6.14

- [x] 5.4 Update `/api/me`: remove the `entitlement` spread from the response (already removed in stage 1 if using the store's entitlement — confirm). Remove the `touchUser` call. Response shape becomes `{ email }`.
  Requirements: 11.7, 11.8

- [x] 5.5 Remove the `dev-insecure-secret-change-me` fallback from `server/auth.js` (line 3). The secret is now always injected from `resolveSessionSecret`.
  Requirements: 7.3

- [x] 5.6 Rewrite `src/AuthGate.tsx`: replace the email+code two-phase form with a single password field. Remove `phase`, `email`, `code`, `devCode`, `requestCode`, `verifyCode` imports. Keep `onCancel`/`heading`/`sub` props for the `"prompt"` variant. Call `signIn(password)` from `src/session.ts`. Update `src/session.ts` with `signIn(password): Promise<Me>` calling `POST /api/auth/signin`.
  Requirements: 6.15

- [x] 5.7 Update `src/CameraPermissionSheet.tsx:38` to use origin-neutral copy instead of referencing `snapgut.com`.
  Requirements: 8.5 (part of origin independence, placed here since it's a trivial copy fix)

- [x] 5.8 Write `src/signin.test.ts`: match, mismatch, empty, oversize, unset credential are all indistinguishable (same status, same error). Write `src/auth.token.property.test.ts`: sign/verify round-trip (Property 10) and tamper rejection (Property 11) as fast-check properties. Write `src/secret.bootstrap.test.ts`: generates on first run, reuses on restart, refuses <32 chars, refuses any value from `.env.example` or the repo.
  Requirements: 6.6, 6.7, 7.1, 7.2, 7.3, 7.14, 13.3

- [x] 5.9 Remove `getCode`, `setCode`, `clearCode` from both store backends (memory and SQLite). Update `src/authRateLimit.test.ts` to use the new `/api/auth/signin` route. Run suite green.
  Requirements: 6.9, 13.3

## Stage 6: Packaging, Origin, Docs, and Deployment

- [x] 6.1 Create `server/config.js` with `loadConfig(env)`: parse every setting into the `Config` shape, accumulate all errors, return `{ ok, config, errors, warnings }`. Validate: PORT 1-65535, BIND_HOST loopback detection, exposed bind + no credential, DATASTORE_BACKEND known, AI_PROVIDER known + required settings, SESSION_SECRET length. Derive `exposedBind`.
  Requirements: 2.11, 4.14, 7.4, 7.14, 8.1, 9.4

- [x] 6.2 Create `server/main.js` as the sole entry point: call `loadConfig`, `resolveSessionSecret`, open datastore, call `buildApp`, then `serve()`. Log boot summary (datastore, AI provider, bind host, port, food pack count, secret source, auth status). Flip `ready` after `serve()` resolves. Exit 1 on any phase failure before listening.
  Requirements: 9.7, 9.8, 9.12, 9.13

- [x] 6.3 Extract `server/app.js` with `buildApp(deps)`: move all route registration out of `server/index.js` into this function, receiving `{ config, store, eventStore, secret, ai, ready }` as arguments. Add `GET /api/health` (unauthenticated, returns `{ ready, schema }`). Delete `server/index.js`.
  Requirements: 9.7, 12.7

- [x] 6.4 Remove origin coupling: delete `CANONICAL_ORIGIN` from `shared/site.js`. Remove the JSON-LD block from `marketing/index.html`. Remove `jsonLdHashes`, `csp-hashes.json` emission, and `size-report.json` emission from `vite/marketing.js`. Simplify `server/csp.js`: remove `loadCspHashes`, `cspHashes`, `reloadCspHashes`, `cspForMarketingPath`, `withScriptHashes`; make `cspFor` return the base `CSP` constant for all classes. Remove `isCanonicalHost` from `server/headers.js`; make `shouldNoIndex` return `noindex` for all classes when `PUBLIC_ORIGIN` is unset, and for `NOINDEX_CLASSES` only when set. Remove `https://www.themealdb.com` from CSP `img-src` and the Workbox runtime-cache rule from `vite.config.ts`. Make `og:image` and `twitter:image` in `marketing/partials/meta.html` root-relative (`/og.png`). Make `robots.txt` default to `Disallow: /` and `sitemap.xml` empty unless `PUBLIC_ORIGIN` is set. Make canonical/og:url in `marketing/partials/head.html` conditional on `PUBLIC_ORIGIN`.
  Requirements: 8.2, 8.9, 8.10

- [x] 6.5 Remove the sync HTTPS check from `server/sync.js` step 1. The transport-scheme concern is now a global opt-in via `REQUIRE_HTTPS` in config. If `REQUIRE_HTTPS` is on, add a middleware in `buildApp` that rejects requests whose derived scheme is not https. Update HSTS: emit the header only when the request arrived over HTTPS or forwarding data says https, and drop `includeSubDomains`.
  Requirements: 7.13, 12.7

- [x] 6.6 Update the `Dockerfile`: base image `node:24-slim`, add a non-root user (`snapgut`), `chown` the data directory, `USER snapgut`. Update `CMD` to `["node", "server/main.js"]`. Create `docker-compose.yml`: one service, `volumes: ["./data:/data"]`, `ports: ["127.0.0.1:${PORT:-8080}:8080"]`, `env_file: .env`, `extra_hosts: ["host.docker.internal:host-gateway"]`, healthcheck, `restart: unless-stopped`. Set `BIND_HOST=0.0.0.0` inside the container via compose env.
  Requirements: 9.1, 9.2, 9.3, 9.6, 9.12

- [x] 6.7 Create `.env.example` with every setting from `Config`, each with a comment for purpose and default. `SESSION_SECRET` and `AUTH_PASSWORD` present but empty. `AI_BASE_URL` commented with the `host.docker.internal` alternative for container-to-host Ollama.
  Requirements: 9.4, 9.5

- [x] 6.8 Delete `infra/` entirely (all Pulumi modules, `Pulumi.prod.yaml`, `infra/package.json`). Remove any infra-related scripts from the root `package.json` scripts. Add a top-level `LICENSE` file (placeholder — owner decides AGPL vs MIT). Update `package.json` `license` field to match.
  Requirements: 9.9, 9.10

- [x] 6.9 Rewrite `README.md`: project description as a self-hosted diary, 5-step quickstart (clone, copy .env, optionally fetch food pack, `docker compose up`, open port), prerequisites (Node 24, Docker, ~70MB for pack), tunnel section with Tailscale example, AI provider table, backup/restore procedures, upgrade section, troubleshooting section (4 entries: unreachable model, port in use, unwritable dir, camera over HTTP), medical disclaimer.
  Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.9, 10.10, 10.11

- [x] 6.10 Rewrite `marketing/privacy.html` for self-hosted data flows. Delete docs that describe removed capabilities or are internal commercial documents: `docs/auth-and-credits.md`, `docs/google-sheets-sync.md`, `docs/competitor-analysis.md`, `docs/positioning.md`, `docs/pre-launch-fixes.md`, `docs/research-and-insights.md`, `docs/launch-accessibility-checklist.md`, `docs/security-and-infra-todo.md`. Rewrite `docs/configuration.md` against the new settings table. Rewrite `docs/datastore.md` as the SQLite schema reference.
  Requirements: 7.11, 10.7, 10.8

- [x] 6.11 Update all tests affected by origin removal: `src/site.table.test.ts` (remove `CANONICAL_ORIGIN` format assertion), `src/robotsSitemap.test.ts` (remove https-only assertion on sitemap locs), `src/marketing.build.test.ts` (remove canonical URL literal, pricing references), `src/marketing.metadata.test.ts` (remove canonical assertions), `src/marketing.isolation.test.ts`, `src/marketingCsp.test.ts` (simplify: no per-page hashes), `src/serverRoutes.test.ts` (remove `isCanonicalHost` cases). Write `src/config.test.ts` (every boot-failure branch), `src/boot.order.test.ts` (exit before listen), `src/health.test.ts` (not-ready then ready), `src/envExample.test.ts` (every setting config.js reads appears in `.env.example`).
  Requirements: 8.2, 8.10, 9.7, 13.3

- [x] 6.12 Update `package.json`: set `"engines": { "node": ">=24" }`, update the `start` script to `node server/main.js`, confirm `dev` script still works with the new entry point. Run the full test suite. Confirm `docker compose up` from a fresh clone with `.env.example` copied reaches ready state within 60 seconds (AI routes may error without a model server — that is expected per Requirement 9.11).
  Requirements: 9.3, 10.3, 13.3, 13.6


## Notes

- **Publication gate**: The repository must stay private until stages 5 and 6 are complete (Requirement 13.8). The `dev-insecure-secret-change-me` literal in `server/auth.js` makes tokens forgeable by anyone who reads the source, and `infra/` still exists until stage 6.
- **Hosted deployment**: Cut a `hosted` branch before stage 1. The existing Cloud Run deployment continues from that branch. The two will diverge and no merge strategy is proposed.
- **Open decisions for the owner**: License (AGPL vs MIT) and branding. Neither blocks any task. The LICENSE file in task 6.8 is a placeholder until the decision lands.
- **Node version**: Stages 2+ require Node 24 for `node:sqlite`. The Dockerfile change in 6.6 pins it; local dev needs it from stage 2 onward.
- **Test suite baseline**: Before starting, run `npm test` and confirm the current suite is green. The task list assumes zero pre-existing failures.
- **Each stage = one PR** (Decision D11). The suite must pass at the end of each, and the server must start from `.env.example` unchanged within 30 seconds.
