# SnapGut 🍽️

A food and symptom diary that runs as an installable **PWA**: snap a meal, log how your gut
feels, and see which foods track with your symptoms. Live at
[snapgut.com](https://snapgut.com).

One repository holds two things that are served from the same origin but share nothing at
runtime: a static marketing site and the app itself.

## What the app does

- **Log meals** — live camera → `POST /api/recognize` → Vertex AI Gemini names the foods →
  confirm, add a note, save. Photos stay on the device; only the frame sent for recognition
  leaves it, and it is not retained.
- **Log symptoms, bowel movements, and daily check-ins** — severity per symptom, Bristol
  scale, stress and sleep.
- **See associations** — on-device food ranking and trends, plus AI insights
  (`POST /api/insights`).
- **Keep your data** — everything lands in IndexedDB first. CSV export and a JSON backup
  live in Settings. Two optional sync destinations, independent of each other: SnapGut Cloud
  (Firestore-backed, a **Pro** feature — see [docs/cloud-sync.md](docs/cloud-sync.md)) and
  Google Sheets ([docs/google-sheets-sync.md](docs/google-sheets-sync.md)).

Accounts are email + a 6-digit code; free AI actions are capped before the paywall. See
[docs/auth-and-credits.md](docs/auth-and-credits.md).

## URL structure

Every path below resolves through one table, `shared/site.js`. The client router
(`src/routes.ts`), the origin server (`server/routes.js`), the service-worker config
(`vite/pwa.js`), the build inputs, and the sitemap all derive from it, so adding a page is
one entry there.

| Path | Serves | Indexable |
| --- | --- | --- |
| `/`, `/pricing`, `/privacy`, `/terms` | static marketing documents from `marketing/` | yes |
| `/login`, `/app`, `/app/logs`, `/app/insights`, `/app/settings` | the one App_Shell, `dist/app/index.html` | no (`noindex`) |
| `/foods/*` | illustration pack, streamed from a private GCS bucket | n/a |
| `/api/*` | JSON | no |
| anything else | the origin's own `404.html`, with status **404** | no |

There is no SPA catch-all: an unknown path is a real 404, never the app shell. A trailing
slash on a marketing path or `/login` gets a 301 to the canonical path. Marketing pages carry
no inline script beyond hashed JSON-LD, load nothing cross-origin, and never pull in the app
bundle — asserted by `src/marketing.isolation.test.ts`.

Launched from the home screen, the manifest opens `/app` directly; a standalone launch that
still lands on `/` is redirected by `marketing/standalone.ts`.

## Repository layout

| Directory | What's in it |
| --- | --- |
| `src/` | the React app (TypeScript) and its tests |
| `app/` | `index.html`, the App_Shell — the only document that loads the app bundle |
| `marketing/` | the marketing pages, their partials, and `marketing.css` — plain HTML/CSS |
| `shared/` | plain ESM shared by client, server, and build: the route table and the plan catalog |
| `server/` | Hono on Node: `/api/*`, the `/foods/*` proxy, route resolution, headers, CSP |
| `vite/` | build plugins: multi-page inputs, partial injection, pricing table, robots/sitemap |
| `infra/` | Pulumi program for the Google Cloud resources ([infra/README.md](infra/README.md)) |
| `scripts/` | generation and ops scripts (food pack, icons, secrets, Stripe test catalog) |
| `docs/` | the written record — configuration, datastore, sync, positioning |
| `public/` | static assets copied verbatim into `dist/` |
| `food-pack/` | the generated illustrations, **not in git** (see below) |

## Run locally

```bash
npm install

# Auth so the server can call Vertex AI with your user credentials:
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project-id

npm run dev
```

Open http://localhost:5173. `npm run dev` runs Vite and the Node server together; Vite
proxies `/api` → :8080 and a dev middleware maps `/login`, `/app/*`, and each marketing path
to the same document class the origin serves in production.

Most local work needs no secrets: with no Resend key the sign-in code comes back in the
response, and with no Stripe key checkout is simulated. Every variable, its default, and what
breaks without it is in [docs/configuration.md](docs/configuration.md) — including how to load
a `.env` (`node --env-file=.env server/index.js`).

> The live camera needs HTTPS or `localhost`. On a phone during dev, use the deployed URL.

## Build and test

```bash
npm run build     # vite build → dist/
npm test          # vitest run
npx tsc --noEmit
```

The build is a **multi-page build**, not a single SPA bundle. `vite/marketing.js` derives one
Rollup input per marketing page plus the not-found document from the route table, and the
App_Shell input is `app/index.html`. After bundling it flattens `dist/marketing/*.html` to the
paths the table names (`dist/index.html`, `dist/pricing.html`, …), leaving the shell at
`dist/app/index.html`, and it fails the build on a referenced asset that was never emitted. It
also emits `robots.txt`, `sitemap.xml`, `csp-hashes.json` (the JSON-LD hashes the server merges
into the marketing CSP), and `size-report.json` for the page-weight budget.

Run `npm run build` **before** the suite: `marketing.isolation.test.ts` and
`pwa.offline.test.ts` assert against `dist/`, so a stale build fails them.

## Deploy

The service is `snapgut` in project `REDACTED-GCP-PROJECT` (`us-central1`). The deploy pipeline owns
the container image; everything else — the service account, env vars, mounted secrets,
Firestore, the load balancer — is declared in `infra/` and applied with Pulumi.

```bash
gcloud run deploy snapgut --source . --region us-central1
```

**Do not pass `--set-env-vars` to that command.** It replaces the revision's whole environment,
which would drop `USERS_BACKEND=firestore`, `TRUSTED_PROXY`, the Stripe price ids, and the
mounted secrets. Configuration changes belong in `infra/service.ts` and its stack config.

Two variables stop a production boot on purpose: `SESSION_SECRET` and `USERS_BACKEND=firestore`.
Everything else degrades one capability at most. The full inventory is
[docs/configuration.md](docs/configuration.md).

### `TRUSTED_PROXY`

Which header `server/clientIp.js` trusts when it derives the address the auth throttle and the
per-IP sync limiter key on. Getting it wrong is a security setting, not a cosmetic one: trusting
a client-controllable header hands out a fresh rate-limit bucket per request.

- `cloudrun` — the second-from-right `X-Forwarded-For` entry, the one a Google front end
  appends. **This is production**: a Google load balancer fronts the service, and the same value
  is correct at the `run.app` hostname.
- `cloudflare` — the edge-set `CF-Connecting-IP`. Only for a Cloudflare-**proxied** hostname;
  Cloudflare is DNS-only here, so nothing writes that header today.
- unset — the rightmost `X-Forwarded-For` entry. Never client-controlled, so never spoofable,
  but behind an edge it is one shared bucket for everyone.

## Food illustration pack

Food thumbnails are our own botanical illustrations, generated with Vertex AI image models —
about 3,000 foods, ~22 KB each as transparent 256 px WebP.

They are **not in git**. They live in a private GCS bucket (`gs://REDACTED-GCP-PROJECT-pack`) and the
server streams them same-origin at `/foods/*` with immutable caching, so the repo and container
stay small and there is no third-party image licensing.

```bash
./scripts/sync-food-pack.sh down    # fresh clone: pull the pack locally (optional)
./scripts/sync-food-pack.sh count   # how many images are in the bucket
```

To extend the pack (e.g. a food showed up as a letter-avatar):

```bash
node scripts/gen-food-list.mjs --target 4000        # add more names (text, pennies)
node scripts/gen-food-images.mjs --dry-run          # what's missing + cost estimate
node scripts/gen-food-images.mjs --only "Natto"     # generate specific foods
node scripts/gen-food-images.mjs --concurrency 6    # generate everything missing
./scripts/sync-food-pack.sh up                      # upload to the bucket
```

Generation is resumable and idempotent (existing files are skipped, `--force` overwrites) and
retries transient failures 3× with backoff. Keep `STYLE` in the script fixed so the set stays cohesive, and add
a `SUBJECT_OVERRIDES` entry for any name a literal reading gets wrong (e.g. "Chicken" → breast
fillets, not a bird). Bump `PACK_VERSION` in `src/imageCache.ts` after adding images so clients
re-check foods they'd previously cached as missing.

## Install on your phone

1. Open https://snapgut.com/login in **Safari** (iOS) or Chrome (Android).
2. Share → **Add to Home Screen**.
3. Launch it from the home screen — full-screen, straight into the app.

## Where the data lives

| Where | What |
| --- | --- |
| The device (IndexedDB) | every log entry, and the photos |
| Our server (Firestore) | `{ email, pro, proUntil, freeAiUsed, stripeCustomerId, createdAt }`, plus queued sync events for Pro accounts |
| Your export | CSV or a JSON backup, from Settings |

Photos are sent to the AI provider to identify a meal and are not retained. Structured entries
reach our server only with SnapGut Cloud switched on. Collections, keys, and expiry are in
[docs/datastore.md](docs/datastore.md); the user-facing version is
[the privacy page](https://snapgut.com/privacy).

## Docs

| Document | Covers |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | every env var and secret, and what breaks without it |
| [docs/cloud-sync.md](docs/cloud-sync.md) | SnapGut Cloud: the Pro gate, what's stored, deletion |
| [docs/datastore.md](docs/datastore.md) | Firestore collections, keys, personal data, expiry |
| [docs/auth-and-credits.md](docs/auth-and-credits.md) | sign-in, sessions, free AI limit, Pro |
| [docs/positioning.md](docs/positioning.md) | the message hierarchy and the claims we must not make |
| [docs/security-and-infra-todo.md](docs/security-and-infra-todo.md) | domain, edge, and launch items |
| [infra/README.md](infra/README.md) | the Pulumi program and the resources it imports |

## Cost notes

- **Cloud Run:** scales to zero; you pay per request.
- **Vertex AI:** Flash-Lite is the cheapest multimodal tier, and camera frames are capped at
  1024 px square before upload to keep tokens down. Model identifiers must stay first-party
  Google models — see the cost guardrails in
  [docs/configuration.md](docs/configuration.md#cost-guardrails).
- **The budget alert notifies; it does not cap.** 200 CAD/month on this project, with alerts
  only.
