# Architecture

A contributor-facing map of the codebase: how a request travels, how the process boots, what each
directory owns, where the deliberate seams are, and how the tests hold them in place.

Written from the code as it stands. Where the code and an existing document disagree, this file
follows the code and says so.

## Shape

One Node process serves everything: the app shell, the static assets, the food illustrations, and
the JSON API. There is no separate frontend server, no queue, no worker, and no external
database — and no marketing site: `/` is the app.

```text
Browser (React 18 PWA, IndexedDB)
   │  fetch /api/*, document and asset requests
   ▼
Reverse proxy or tunnel (operator-provided, optional)
   ▼
Node 24 process
   ├─ Hono app (server/app.js)      routes and middleware
   ├─ node:sqlite                   one file, DB_PATH
   ├─ food pack directory           FOOD_PACK_DIR, WebP files
   └─ AI provider over fetch        Ollama, an OpenAI-shaped gateway, or a hosted API
```

The device is the source of truth. IndexedDB holds the timeline, every statistic the app displays
is computed in the browser, and the server is an optional replica that also brokers the two AI
calls. That inversion is the single most important thing to hold in mind when changing anything:
the server going away degrades the app, it does not break it.

## The request path

`server/main.js` is the only module that calls `serve()`. Everything else is importable without
binding a port, which is what makes route-level tests possible in-process.

`buildApp(deps)` in `server/app.js` registers, in this order:

1. **`REQUIRE_HTTPS` guard** (`app.use("*")`, only when enabled). Derives the scheme from
   `X-Forwarded-Proto` and answers `403 {"error":"https_required"}` when it is not `https`. The
   Node server does not expose TLS state to Hono, so the header is the only signal — with no
   proxy in front, this rejects everything, including `/api/health`.
2. **Security headers and the per-class header pass** (`app.use("*")`). Sets `c._publicOrigin`,
   awaits the rest of the chain, then applies `X-Content-Type-Options`, `X-Frame-Options`,
   `Referrer-Policy`, `Permissions-Policy`, HSTS (only when the request really arrived over
   HTTPS), and finally `applySiteHeaders(c)` from `server/headers.js`.
3. **Body cap on `/api/*`.** `Content-Length` over 8 MiB gets `413 payload_too_large` before any
   body is read.
4. **Sign-in rate limit on `/api/auth/*`.** 20 requests per 60 s per derived client address,
   through `store.rateLimit`.
5. **API routes.** `/api/health`, `/api/recognize`, `/api/insights`, `/api/auth/signin`,
   `/api/me`, `/api/account/delete`.
6. **Sync routes** via `registerSyncRoutes(app, …)` from `server/sync.js`, which adds its own
   body-size, authentication, and two-tier rate-limit chain.
7. **`/foods/:file`** — validated food-pack reads with an immutable cache header.
8. **Site routes** via `registerSiteRoutes(app)` from `server/routes.js`: the trailing-slash
   redirect, the app shell for `/`, `/login`, `/app` and `/app/*`, static files from `dist/`, and
   a terminal 404.

Registration order is load-bearing. Hono matches in registration order, so the site routes must
be mounted **last** — the `/*` static handler and the `*` catch-all would otherwise swallow
`/api/*` and `/foods/*`. Both `server/routes.js` and `server/app.js` carry comments saying so.

A typical recognition request, end to end:

```text
browser: photo Blob → base64 (src/api.ts)
  POST /api/recognize  { image, mimeType, note? }
    → REQUIRE_HTTPS guard, header middleware, 8 MB cap
    → verifyToken(bearer) → email, or 401
    → recognizePrompt(note) built in server/app.js
    → ai.generate({ prompt, image, json: true, signal: AbortSignal.timeout(timeoutMs) })
    → log: ai { provider, kind: "recognize", outcome, elapsedMs }
    → JSON.parse defended; sanitizeMeal caps at 10 ingredients
    → annotateIngredients() adds canonical slugs, tallies unknowns fire-and-forget
  ← 200 { dish, ingredients }   (or 503 { error: "ai_unavailable" })
browser: stores the event and the photo Blob in IndexedDB
```

## Boot sequence

Five ordered phases in `server/main.js`. Phases 1 through 4 exit 1 on failure, before anything
listens.

| Phase | Call | Failure mode |
| --- | --- | --- |
| 1. config | `loadConfig(process.env)` | Logs each `config error:` line, exits 1 |
| 2. secret | `resolveSessionSecret(config)` | Logs `secret error:`, exits 1 |
| 3. datastore | `openDatabase(DatabaseSync)` + `migrate(db)`, or the memory stores | Logs the path and error, exits 1 |
| 4. app | `createAiProvider(config)` then `buildApp({config, store, eventStore, secret, ai, ready})` | Logs `ai config error:`, exits 1 |
| 5. listen | `serve(...)`, then `ready.value = true`, then the boot summary | — |

Two design choices worth understanding before you change this file.

**`loadConfig` is pure.** It takes an env-shaped object, returns
`{ ok, config, errors, warnings }`, and never reads a file, logs, or throws. Two things fall out:
a test constructs config by calling `loadConfig({...})` with a literal instead of mutating
`process.env`, and every validation error for one boot can be reported together rather than one
per run. The result is frozen, and it is the configuration surface for everything below
`main.js`.

Three places still read `process.env` directly, and it is worth knowing which:

- `server/sqlite/open.js` reads `process.env.DB_PATH` rather than `config.dbPath`.
- `server/clientIp.js` reads `process.env.TRUSTED_PROXY` per call, deliberately, so a test can
  switch modes without re-importing the module.
- `server/store.js` reads `process.env.DATASTORE_BACKEND` at module scope for its own `getStore()`
  path.

**`ready` is a mutable cell, separate from "listening".** `GET /api/health` returns
`{ready: ready.value, schema: 1}`. Since the datastore opens in phase 3 and the socket exists only
in phase 5, the datastore is always open before any request can arrive — which would make the
not-ready state unreachable and therefore untestable. Passing a `{ value: boolean }` cell into
`buildApp` lets a test hold it at `false` and assert the not-ready response, and leaves somewhere
to report a future degraded state without changing the response contract.

There is no separate `server/boot.js`: all five phases are inlined in `server/main.js`. The rule
that matters held anyway — `main.js` is the only module that calls `serve()`, so there is exactly
one place where the process starts listening.

## Module layout

| Path | Owns |
| --- | --- |
| `server/main.js` | The five boot phases and the only `serve()` call |
| `server/config.js` | Env parsing and validation; the frozen `Config` and its JSDoc typedef |
| `server/secret.js` | Session secret: from env, from `${DATA_DIR}/session-secret`, or generated at 0600 |
| `server/app.js` | `buildApp()` — every route, both AI prompts, the defended parses, no listener |
| `server/auth.js` | HMAC-SHA256 session tokens (30-day expiry) and constant-time credential comparison |
| `server/sync.js` | The sync endpoint chain: limits, validation, photo rejection, redacted logging |
| `server/eventStore.js` | The event-store contract, the merge planner, cursors, and the memory backend |
| `server/store.js` | Users, rate limits, missing-food tallies, and the memory backend |
| `server/sqlite/` | `open.js` (resolve and open), `schema.js` (migrations, PRAGMAs), `store.js`, `eventStore.js` |
| `server/ai/` | `index.js` (provider selection), one adapter per provider, `url.js` (base-URL and header helpers) |
| `server/routes.js` | Path-to-outcome resolution and the document/static/redirect/404 handlers |
| `server/headers.js` | Response classification and the per-class `Cache-Control`, `X-Robots-Tag`, `Content-Type`, CSP |
| `server/csp.js` | The one Content-Security-Policy |
| `server/foodPack.js` | Validated pack reads and the boot-time survey |
| `server/foodDict.js`, `server/food-dict.json` | Ingredient-to-slug canonicalisation |
| `server/clientIp.js` | The single place a client address is derived for rate limiting |
| `shared/site.js`, `shared/site.d.ts` | The route table: root path, login path, app prefix, app views, the 404 filename |
| `src/` | The React PWA in TypeScript, plus every test |
| `vite/` | Build-time plugins: `pwa.js` (service-worker path sets), `devRoutes.js` (dev-server document mapping) |
| `app/index.html` | The single app-shell document |
| `404.html` | The standalone not-found document, a build input in its own right |
| `public/` | Copied verbatim into `dist/`: icons, favicons, `robots.txt` |
| `scripts/` | Generators (icons, OG images, food dictionary) and `fetch-food-pack.mjs` |
| `docs/` | This documentation |
| `dist/` | Build output. The server serves documents and assets from here |

`server/` and `shared/` are plain ESM JavaScript with JSDoc types; `src/` and `vite/` are
TypeScript and JavaScript respectively. `shared/` is JavaScript specifically so `server/`,
`vite/` and `src/` can all import it without a build step, with `shared/site.d.ts` carrying the
types for the TypeScript side.

## The datastore abstraction

Two store interfaces, two backends each.

| Interface | Methods | Backends |
| --- | --- | --- |
| `store` | `getUser`, `upsertUser`, `deleteUser`, `rateLimit`, `recordMissingFood`, `listMissingFoods` | `server/store.js` (memory), `server/sqlite/store.js` |
| `eventStore` | `push`, `pull`, `deleteAll`, `countFor`, `getMeta` | `server/eventStore.js` (memory), `server/sqlite/eventStore.js` |

`DATASTORE_BACKEND` selects between them: `sqlite` (default) or `memory`. Both keep `async`
signatures even though `node:sqlite` is synchronous, so callers cannot tell them apart. The
memory backend exists for the test suite — `vitest.config.ts` sets
`env: { DATASTORE_BACKEND: "memory" }` — and loses everything on exit.

The interesting part is not the two implementations but what keeps them honest. The event store's
semantics are not CRUD: a per-account monotonic sequence, a purge epoch that invalidates issued
cursors, a per-id clock clamp with a re-send recognition rule, a 180-day tombstone sweep, and a
merge ordering that is total over arbitrary JSON. Everything backend-independent — `planPush`,
`mergeRecords`, `compareForMerge`, `canonicalKey`, `normalizeForStore`, `clampUpdatedAt`,
`formatCursor`, `parseCursor`, `pageLimit`, `storableId` — lives at module scope in
`server/eventStore.js`. A backend is only a commit path over that shared planner.

Two property-based tests assert the backends are indistinguishable:

- `src/datastore.equivalence.test.ts` — `createSqliteStore` versus the memory store.
- `src/eventStore.equivalence.test.ts` — `createSqliteEventStore` versus the memory event store,
  driving an injected `now` that advances by 0, 1 ms, 1 s, 1 day, or 180 days between calls so
  the sweep and clamp boundaries are actually crossed.

Both use `fast-check` to generate operation sequences and compare observable results step by
step. If you add a store method, add it to both backends and extend the generator; a divergence
that the equivalence test does not generate is a divergence nothing will catch.

The schema lives in `server/sqlite/schema.js` as an ordered array of migrations with a
`schema_meta.version` row, each applied in its own transaction, forward-only. See
[datastore.md](datastore.md) for the tables and [operations.md](operations.md) for the upgrade
implications.

## The AI adapter boundary

`server/ai/index.js` maps `AI_PROVIDER` to one adapter and returns:

```text
{ name, model, generate({ prompt, image, json, signal }) -> Promise<string> }
```

An adapter's whole job is protocol translation: build the provider's request shape, send the
base64 image in the field that provider expects, throw on a non-2xx or a missing content field,
and return the raw response text. `server/ai/url.js` holds the two things every adapter needs —
base-URL normalisation that will not produce `/v1/v1/`, and a header merge that puts the
adapter's own auth headers last so `AI_EXTRA_HEADERS` cannot override them.

Prompt construction, JSON parsing, and timeout enforcement stay at the two call sites in
`server/app.js`. That is deliberate, for three reasons:

- **The failure mode is a product decision, not a protocol one.** A model that answers in prose
  should give recognition an empty meal with a 200 and give insights the prose as its body.
  Encoding that per adapter would mean seven copies of a decision that belongs in one place.
- **Prompts are versioned with the routes that own them.** The recognition prompt and the insight
  focus prompts are part of the app's behaviour; an adapter has no business knowing what a
  FODMAP is.
- **Adapters stay trivially testable.** Each one is a pure function from a request shape to a
  `fetch` call, so `src/ai.adapters.test.ts` can assert the exact body sent without a model.

The corollary: if you add a provider, add a file to `server/ai/`, a `case` in `createAiProvider`,
and a validation branch in `server/config.js`. Do not add parsing.

## The route table

`shared/site.js` is the single source of truth for every public path: `ROOT_PATH`, `LOGIN_PATH`,
`APP_PREFIX`, `APP_VIEWS`, `DEFAULT_APP_PATH`, `NOT_FOUND_FILE`, and `isAppPath`. Four consumers
derive from it rather than repeating literals: the client router, `server/routes.js`,
`server/headers.js`, and `vite/devRoutes.js` (the dev-server document mapping).

`resolveRoute(pathname)` in `server/routes.js` states the outcome for any path — `redirect`,
`app-shell`, `static`, `not-found` — in the same order the handlers are registered, so a path
cannot resolve one way in the resolver and another way in the running server. Tests call
`resolveRoute` directly.

**The origin root is the app.** `/`, `/login`, `/app` and `/app/*` are all answered with the one
app-shell document. `/` is deliberately *not* a redirect to `/app`: a 301 cannot be served from
the service-worker cache, so a redirect would make a bare-host launch fail offline. It is also
registered ahead of the static handler, so a `dist/index.html` left behind by an older build
cannot shadow it. The client side of the decision is in `src/routes.ts`, where `parseRoute("/")`
resolves to the default addressable view, and in `src/useRouter.ts`, whose URL → state effect
rewrites the address to `/app` with `history.replaceState` — replacing rather than pushing, so
the back gesture leaves the app instead of bouncing between the two spellings.

`/login/` is the only trailing-slash redirect left. `/nonsense/` takes a single 404 rather than a
301 onto another 404, and an app route keeps its 200 so the shell answers exactly the paths
`isAppPath` recognises.

`server/headers.js` classifies a response by path **and actual status**, then applies that class's
policy:

| Class | `Cache-Control` | Notes |
| --- | --- | --- |
| `api` | `no-store` | Always `noindex` |
| `foods` | left as the handler set it | The handler sets `immutable` for a year |
| `app-shell` | `no-cache` | `/`, `/login`, `/app`, `/app/*` |
| `hashed-asset` | `public, max-age=31536000, immutable` | `/assets/*` |
| `revalidate-asset` | `no-cache` | `/sw.js`, the manifest — so a deploy is picked up |
| `crawler-file` | `public, max-age=3600` | `robots.txt` |
| `other-static` | `public, max-age=3600` | Icons, favicons |
| `redirect` | left alone | Classified by status, not path |
| `not-found` | `no-store` | The 404 document |

Classifying redirects and 404s by status rather than by a second path-matching pass means the
headers describe what the server actually answered. `X-Robots-Tag: noindex` goes on **every**
response, whatever the class and whatever `PUBLIC_ORIGIN` is: with the marketing site gone there
is no indexable surface, and a self-hosted health diary should not be in a search index.
`robots.txt` says the same thing (`Disallow: /`) and is a static file in `public/` rather than a
build artifact — there is nothing left to derive. No `sitemap.xml` is emitted.
`server/csp.js` returns one policy for every class, with no `unsafe-inline` or `unsafe-eval` in
`script-src`.

## Sync, briefly

`POST /api/sync/push`, `GET /api/sync/pull`, `DELETE /api/sync/data`, all bearer-authenticated.
Push stores up to 200 records atomically and returns one outcome per submitted id; pull pages up
to 500 records by ascending sequence behind an opaque `"{epoch}:{seq}"` cursor; delete purges the
caller's records and bumps the epoch, which invalidates every cursor previously issued.

Two properties are structural rather than checked. Cross-account access is impossible because the
account is part of the primary key and comes from the verified token, never from the request body.
Photos cannot be stored because the client's wire codec has no `photo` field **and** the server
rejects payloads carrying photo-shaped data with `400 photo_field`.

Logging in `server/sync.js` is redacted by construction: one function writes every line, from a
fixed field vocabulary it derives itself, with a caught error contributing its class name only.

Full protocol in [cloud-sync.md](cloud-sync.md).

## The client

Offline-first, in `src/`:

- **IndexedDB is the database.** `src/db.ts` opens `food-snap` at version 3 with `events`,
  `outbox` and `meta` stores. Every view reads from there.
- **Photos never leave the device**, except transiently for recognition. They are stored as
  `Blob`s on the event record; the sync codec has no field for them; `attachPhoto` deliberately
  does not enqueue to the outbox or bump the revision time, because a photo is not a new
  revision.
- **Analysis is local.** `src/insights.ts`, `src/foodScores.ts`, `src/mealOutcome.ts` and
  `src/fodmap.ts` compute patterns, food ranking and statistics in the browser. `/api/insights`
  receives an already-aggregated summary and only narrates it.
- **The service worker** (`vite-plugin-pwa`, configured through `vite/pwa.js`) precaches the app
  shell and hashed assets and answers every navigation from the shell through
  `navigateFallback` — including `/`, which is what makes a launch from the bare host work
  offline. `globIgnores` excludes `/foods/**` (thousands of illustrations would bloat the install;
  they are runtime-cached on demand) and `404.html` (its status *is* the response, and a precached
  copy would be served with 200). `navigateFallbackDenylist` keeps `/api/*`, `/foods/*` and
  `robots.txt` reaching the server — those are not navigations, and an HTML body would be the
  wrong kind of answer.
- **A secure context** is required by the browser for live camera capture, PWA install and
  offline caching. On plain HTTP the app falls back to the file picker. See
  [deployment.md](deployment.md).

## Test strategy

`vitest`, one flat suite, colocated with the code in `src/`. Current state:
**82 test files, 1161 tests**, in roughly 8 seconds.

```bash
npm test                      # vitest run
npx vitest run src/config.test.ts
npx vitest                    # watch
```

Configuration facts that matter when adding a test (`vitest.config.ts`):

- `environment: "jsdom"` is the default. Server-side tests opt out with a
  `// @vitest-environment node` pragma on the first line.
- `include: ["src/**/*.{test,spec}.{ts,tsx}"]` — server tests live in `src/` too and import
  `../server/*.js`. There is no separate server suite.
- `DATASTORE_BACKEND=memory` is set for the whole run.
- `virtual:pwa-register` is aliased to a stub, since the PWA plugin does not run under test.

Four kinds of test, by intent:

| Kind | Examples | What it holds |
| --- | --- | --- |
| Unit | `config.test.ts`, `clientIp.test.ts`, `ai.adapters.test.ts` | One module's contract, including every boot-failure branch |
| Property-based (`fast-check`) | `datastore.equivalence.test.ts`, `eventStore.equivalence.test.ts`, `serverRoutes.property.test.ts`, `auth.token.property.test.ts`, `pwa.property.test.ts` | Invariants over generated input, where an example-based test would only sample |
| Route-level | `serverRoutes.test.ts`, `syncRoutes.test.ts`, `health.test.ts`, `signin.test.ts` | The real Hono app via `buildApp`, no socket |
| Component | `*.test.tsx` with Testing Library | The React surface, including accessibility expectations |

Some suites are guard rails rather than feature tests: `syncRoutes.privacy.test.ts` asserts what
may not appear in a log line, and `envExample.test.ts` keeps `.env.example` aligned with the
config parser. Expect to update those when you change behaviour, and read the failure message
before assuming the test is wrong.

## Where to change things

| Task | Files |
| --- | --- |
| Add or change an environment variable | `server/config.js`, `.env.example`, `docs/configuration.md`, `src/config.test.ts`, `src/envExample.test.ts` |
| Add an AI provider | `server/ai/<provider>.js`, `server/ai/index.js`, `server/config.js`, `src/ai.adapters.test.ts`, [ai-providers.md](ai-providers.md) |
| Change a prompt or the parse fallback | `server/app.js` (`recognizePrompt`, `BASE_INSIGHT_PROMPT`, `FOCUS_PROMPTS`, `sanitizeMeal`) |
| Add an API route | `server/app.js`, before `registerSiteRoutes`; a route-level test in `src/` |
| Add an addressable view | `shared/site.js` (one `APP_VIEWS` entry), `src/App.tsx`, `src/routes.test.ts` |
| Change what a path resolves to | `server/routes.js`, `vite/devRoutes.js`, `src/serverRouteResolution.test.ts`, `src/serverRoutes.property.test.ts` |
| Change caching or robots behaviour | `server/headers.js`, `public/robots.txt`, `src/serverRoutes.test.ts` |
| Change the CSP | `server/csp.js`, `src/csp.test.ts` |
| Add a database table or column | `server/sqlite/schema.js` (a new migration entry — never edit version 1), both backends, both equivalence tests, [datastore.md](datastore.md) |
| Change a store method | `server/store.js` or `server/eventStore.js` **and** the matching `server/sqlite/*.js`, plus the equivalence test's generator |
| Change the sync protocol | `server/sync.js`, `src/cloudSync.ts`, [cloud-sync.md](cloud-sync.md) |
| Change client storage | `src/db.ts` (bump `DB_VERSION` and add an upgrade branch), `src/db.migration.test.ts` |
| Change service-worker caching | `vite/pwa.js`, `src/pwa.property.test.ts`, `src/pwa.offline.test.ts` |
| Change the boot sequence | `server/main.js`, `src/boot.order.test.ts`, `src/bootGuards.test.ts` |
| Change the food pack path handling | `server/foodPack.js`, `src/foodPack.test.ts`, `src/foodPack.serve.test.ts` |

## Known documentation drift

Two entries previously listed here have been resolved and are recorded because the resolution is
worth knowing:

- [datastore.md](datastore.md) described migrations as `CREATE TABLE IF NOT EXISTS` statements.
  It now documents what `server/sqlite/schema.js` does: a versioned migration array keyed on
  `schema_meta.version`. The effect (idempotent at boot, forward-only) was always the same; only
  the mechanism was described wrongly.
- `server/clientIp.js` implemented a `cloudrun` mode that `server/config.js` rejected at boot.
  The mode is gone. `none` and `xff` remain **one** derivation — the rightmost
  `X-Forwarded-For` entry — differing only in stated operator intent, and the docs and
  `src/clientIp.test.ts` now say so explicitly rather than implying two behaviours.
