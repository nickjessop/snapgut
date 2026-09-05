# Open-Source Release Readiness — `nickjessop/snap-gut`

Working checklist for taking this repo from "pushed private" to "safe to make public".
Delete or move this file at publication; it is a planning artifact, not user documentation.

Audit date: 2026-08-27. Repo state at audit: 343 tracked files, 121 commits, single `master`
branch, remote `https://github.com/nickjessop/snap-gut.git` (private).

## Status

Everything actionable is done. What remains is nine owner decisions that need your call or your
credentials — they are collected in [§8](#8-owner-decisions--still-open) and nothing else in this
document is blocked on them.

| | Before | After |
| --- | --- | --- |
| Tests | 82 files / 1048 passing (on Node 20, below the project's own floor) | **82 files / 1161 passing on Node 24, 25 and 26** |
| `tsc --noEmit` | 55 errors locally, 132 on a clean install | **0 errors** |
| CI | none | **GitHub Actions green: typecheck → build → test on Node 24 + 26, plus a docker build** |
| Tracked files | 343 | **259** |
| AI providers | 4 | **7** |
| Community health files | none | LICENSE (full AGPL), CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG, COPYRIGHT, issue + PR templates |
| Docs | 5 files | **10 files** |

---

## 0. Answer up front: what AI endpoints can people use?

**The premise that this is Vertex-only was out of date.** Vertex AI was removed during the
self-hosted conversion (spec stage 3). There is no Vertex client library in `package.json`, and
`server/` contains zero Vertex/`aiplatform`/`googleapis` references. Vertex survived only in
hand-run asset-generation scripts under `scripts/` and as a rejected-value fixture in tests.

### What was already there

`server/ai/` holds a clean adapter layer. An adapter is a plain object
`{ name, model, generate(req) -> Promise<string> }`; `createAiProvider(config)` in
`server/ai/index.js` dispatches on `AI_PROVIDER`. Prompt construction, JSON parsing, and timeout
enforcement all live at the call sites in `server/app.js`, not in the adapters. Four providers:
`ollama` (default), `openai`, `gemini`, `mock`.

So flexibility already existed in principle — the `openai` adapter is an OpenAI-compatible
client, which is the lingua franca every gateway speaks. Three things stopped it from actually
working against LiteLLM and friends, and all three are now fixed:

1. **Base URL doubling.** The adapter appended `/v1/chat/completions` unconditionally, so a
   LiteLLM or vLLM URL already ending in `/v1` became `/v1/v1/chat/completions` → 404.
2. **JSON mode was forced.** `response_format: {type:"json_object"}` was always sent. Many
   gateway-proxied models reject the field outright with a 400.
3. **No custom headers.** LiteLLM virtual keys, OpenRouter's attribution headers, and Azure-style
   auth all need a header the adapter could not send.

### What people can use now

| `AI_PROVIDER` | Talks to | Default base URL | Key |
| --- | --- | --- | --- |
| `ollama` (default) | Ollama | `http://127.0.0.1:11434` | No |
| `openai` | OpenAI | `https://api.openai.com` | Optional |
| `litellm` | LiteLLM proxy | `http://127.0.0.1:4000` | Optional |
| `openai-compatible` | vLLM, LM Studio, llama.cpp, OpenRouter, Groq, Together, Fireworks, DeepSeek, Mistral, text-generation-webui | none — `AI_BASE_URL` required | Optional |
| `anthropic` | Anthropic Messages API | `https://api.anthropic.com` | Yes |
| `gemini` | Google Generative Language API | `https://generativelanguage.googleapis.com` | Yes |
| `mock` | nothing | — | No |

Plus two escape hatches across the OpenAI-shaped providers:

- `AI_JSON_MODE` — `auto` (default), `json_object`, or `off`. `off` never sends the structured
  output field; the prompt already asks for JSON and both call sites already defend the parse.
- `AI_EXTRA_HEADERS` — JSON object of extra request headers, merged **under** the adapter's own
  auth headers so a bad entry cannot break authentication.

`litellm` and `openai-compatible` reuse the OpenAI adapter with a different `name` (so logs say
which) and a different base-URL default. One HTTP shape, one code path, one set of tests, three
discoverable config values.

Full walkthrough with worked configs for each: `docs/ai-providers.md`.

---

## 1. Blockers — done

- [x] **1.1 Secrets audit.** No `.env`, private key, or credential value is tracked or in
      history. Verified.
- [x] **1.2 Untracked `.kiro/settings/mcp.json`.** It configured an enabled Stripe MCP server
      with `stripe_api_write` in its `autoApprove` list — publishing it would hand any
      contributor's agent a pre-approved write path to Stripe tooling. File stays on disk.
- [x] **1.3 Untracked the four stale spec folders.** `marketing-site-and-routing/` was the
      biggest leak in the repo: GCP project `REDACTED-GCP-PROJECT` and project number, the runtime
      service account, billing account id, budget id, Stripe account/product/price/customer ids,
      a personal email, another company's name and domain, the full `snapgut.com` DNS layout, and
      a detailed writeup of a window in which `/api/billing/checkout` granted Pro without payment
      on the live service. Also untracked `cloud-sync/`, `google-sheets-integration/`,
      `native-app-store-launch/`. Kept `self-hosted-open-source/` — it documents the current
      design. All files stay on disk; only tracking changed. **History still contains them —
      see 8.1.**
- [x] **1.4 `LICENSE` is now the full AGPL-3.0 text** (661 lines, 34,523 bytes) instead of a
      21-line notice that ended "This is a placeholder license. The project owner may change to
      MIT". Added `COPYRIGHT` with the correct year (2026, not 2024).
- [x] **1.5 Fixed the broken clone URL.** Was `nickvdyck/food-snap` — wrong owner and wrong
      repo, so the first command a self-hoster ran failed.
- [x] **1.6 Untracked `.playwright-mcp/`** — 59 committed browser test artifacts. The
      `.gitignore` entry already existed but does nothing for files committed before it.
- [x] **1.7 `.dockerignore` now excludes `.env`, `.env.*`, `data/`.** `Dockerfile:6` is
      `COPY . .`, so a developer's `.env` (auth password, `AI_API_KEY`, `SESSION_SECRET`) and
      their `data/snapgut.db` diary were being baked into the build-stage layer.
- [x] **1.8 Weak or absent credential now refuses to boot on an exposed bind.** 12-character
      minimum; an unusable credential resolves to `null` so the existing signin short-circuit
      rejects it with one identical 401 rather than a second code path. Loopback warns instead of
      failing, so development is not blocked. Verified live: `exit=1`, nothing ever listens, and
      no message carries the credential or its length.
- [x] **1.9 De-branded hosted-only leakage.** Removed `© REDACTED-ENTITY` from the shipped
      footer (replaced with the AGPL notice and a source link, which AGPL §13 wants anyway),
      deleted four dead operator scripts that hardcoded the GCP project and the DNS zone, and
      removed the private GCS bucket name from `.gitignore`.

---

## 2. AI provider flexibility — done

- [x] **2.1** `AI_BASE_URL` normalized; `/v1` is not doubled. Verified across all four forms.
- [x] **2.2** `AI_JSON_MODE` (`auto` | `json_object` | `off`) added and validated.
- [x] **2.3** `AI_EXTRA_HEADERS` added, validated as a JSON object of string values, merged under
      the adapter's own headers.
- [x] **2.4** `litellm` provider value added.
- [x] **2.5** `openai-compatible` provider value added, with a `ConfigError` when `AI_BASE_URL`
      is unset since there is nothing sensible to guess.
- [x] **2.6** `anthropic` adapter added (`/v1/messages`, `anthropic-version: 2023-06-01`, image
      block before text, API key required).
- [x] **2.7** `AI_BASE_URL` can now override the Gemini host, for proxied setups.
- [x] **2.8** Fixed the missing null check in `server/ai/ollama.js`. A malformed reply used to
      yield `undefined`, making the call site's `JSON.parse` throw and silently degrade to an
      empty meal with HTTP 200 instead of a 503.
- [x] **2.9** Both provider allow-lists and the literal provider loop in `src/config.test.ts`
      updated.
- [x] **2.10** `.env.example`, `docs/configuration.md` and the README provider table updated.
- [x] **2.11** Tests added in the existing style. +61 tests.

---

## 3. Community health and CI — done

- [x] **3.1** `CONTRIBUTING.md` — setup with `AI_PROVIDER=mock` (no model server or API key
      needed), the three pre-PR checks, project layout, a six-step guide to adding an AI provider,
      test conventions, and a note that `server/` stays JavaScript on purpose.
- [x] **3.2** `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1. Uses GitHub's report-abuse flow
      rather than inventing a contact email.
- [x] **3.3** `SECURITY.md` — private reporting via GitHub, no fabricated email, no bug bounty
      promised, plus a substantial "Self-hosting security notes" section (TLS, the credential
      minimum, secret rotation, `TRUSTED_PROXY` failure modes, a per-provider data-egress table,
      backup sensitivity) and an explicit scope split between misconfiguration and vulnerability.
- [x] **3.4** `.github/ISSUE_TEMPLATE/` (bug, feature, config) and `PULL_REQUEST_TEMPLATE.md`.
- [x] **3.5** `CHANGELOG.md` — Keep a Changelog, seeded with an undated `0.1.0`.
- [x] **3.6** `.github/workflows/ci.yml` — `test` job (Node 24 + 26 matrix: `npm ci`, typecheck,
      test, build) and a `docker` job that builds the image without pushing. Read-only token,
      concurrency cancellation, actions pinned to current majors. Action pins and the Node 26
      line were both independently verified rather than guessed.
- [x] **3.7 Added `typecheck` and `ci` scripts — and cleared all 55 type errors first.** A gate
      that fails on arrival is worse than no gate. `tsc --noEmit` is now 0, with no
      `tsconfig.json` weakening and no blanket suppressions: the TS7016s got the repo's existing
      `@ts-ignore` import convention, the TS6133s were genuinely dead declarations (several
      left over from the removed entitlement feature) and were deleted, and the eight TS18046s
      turned out to share one root cause — an un-instantiated `vi.spyOn` type erasing recorded
      arguments to `unknown[]` — fixed in one line.
- [x] **3.8** `.editorconfig` added, matching the conventions actually in the tree.
- [x] **3.9** `passWithNoTests` flipped to `false`. Left at `true`, a broken `include` glob would
      turn CI green while asserting nothing — precisely the failure the gate exists to catch.
      Also deleted `scripts/check-coverage.mjs`, which was wired to no script and could not run.

---

## 4. Repo hygiene — done

- [x] **4.1** `.gitignore`: added `data/` (Compose mounts `./data:/data`, so every self-hoster's
      SQLite diary was landing in the working tree unignored, one `git add .` from being
      committed), plus `coverage/`, `*.tsbuildinfo`, `.idea/`, `.vscode/`, and `.env.*` with a
      `!.env.example` negation.
- [x] **4.2** Deleted the tracked empty `.vscode/settings.json`.
- [x] **4.3** Removed the stale `.gitignore` comments naming the GCS bucket and the Pulumi stack
      convention.
- [x] **4.5** Reframed the removed-Firestore commentary in `server/store.js`,
      `server/eventStore.js` and `server/sync.js`. Judgement applied rather than blanket
      deletion: comments that only said "Firestore backend removed" went; comments recording *why*
      non-obvious code is shaped the way it is were rewritten to state the constraint in its own
      terms. One was factually wrong and is now corrected — it claimed the SQLite backend does not
      sweep tombstones, which it does, from the same two entry points as the memory backend.
- [x] **4.4** `brand/app-icon.png` (2.4 MB) left in place — noted as a candidate for a release
      asset, not worth churn now.

---

## 5. Documentation — done

- [x] **5.1** README security callout: loopback default, no own TLS, the 12-character minimum,
      and that the server refuses to start on an exposed bind without one.
- [x] **5.2** README development section with the project layout table.
- [x] **5.3** README points at CONTRIBUTING / CODE_OF_CONDUCT / SECURITY / CHANGELOG and now
      names AGPL-3.0-or-later in prose with what it practically means.
- [x] **5.4** README documents that the build also serves marketing pages at `/`, `/privacy`,
      `/terms` — so the homepage of an instance is a landing page, not the diary. Surprising and
      previously undocumented.
- [x] **5.5** README screenshots added with descriptive alt text.
- [x] **5.6** `docs/deployment.md` — Compose line by line, a hardened systemd unit, complete
      Caddy and nginx samples, Traefik labels, the `REQUIRE_HTTPS` / `TRUSTED_PROXY` coupling,
      tunnels, a reverse-proxy checklist.
- [x] **5.7** `docs/ai-providers.md` — the Ollama walkthrough including the Docker
      `host.docker.internal` trap, LiteLLM with a worked `config.yaml`, `openai-compatible`
      settings for vLLM / LM Studio / llama.cpp / OpenRouter, the hosted APIs, `mock`, both escape
      hatches, troubleshooting keyed on what the operator actually sees, and a privacy table.
- [x] **5.8** `docs/operations.md` — boot summary line by line, health checks, exactly what is
      and is not logged, hot and cold backups **with a verification procedure**, restore into a
      fresh install, secret rotation, moving hardware, upgrades, SQLite failure modes, uninstall.
      Includes the caveat that matters most: meal photos live only in the browser, so a
      server-side backup does not contain them.
- [x] **5.9** `docs/architecture.md` — request path, the five boot phases and why `loadConfig` is
      pure and `ready` is a separate cell, module layout, the datastore equivalence tests, the AI
      adapter boundary rationale, the shared route table, test strategy, and a "where to change
      things" table.
- [x] **5.10** `docs/README.md` index; README links all ten docs.
- [x] **5.12** `docs/configuration.md` updated for the new credential rules.

---

## 6. Product surface leftovers — done

- [x] **6.1** Removed the Pro/paywall/app-store surfaces. Sync and export are no longer
      advertised as Pro-gated (the gate does not exist — no `upgrade_required` or 402 remains
      anywhere in `server/`); the spreadsheet destination is gone entirely; the App Store and
      Google Play badges and their image files are deleted, which also resolves the redistribution
      question in 1.13. The `.paywall-*` CSS was **live** — reused by two non-billing bottom
      sheets — so it was renamed to `.sheet-*` rather than deleted, and only the genuinely
      orphaned rules were removed. `privacy.html` and `terms.html` were checked and left alone;
      both already read correctly for self-hosting and satisfy the four elements Requirement 7.11
      asks for.

---

## 7. Correctness findings surfaced while documenting — done

These were not in the original audit. They came out of writing docs against the actual code, and
each was a place where the code, a doc, or both were wrong.

- [x] **7.1 `TRUSTED_PROXY=xff` had no implementation branch.** It behaved identically to `none`
      while the docs described them as different mechanisms. Resolved in favour of one derivation
      with honest docs rather than inventing a second branch: the rightmost `X-Forwarded-For`
      entry is the only entry a client cannot forge, so it is already correct both behind a single
      trusted proxy and with no proxy. A second nearly-identical branch in the rate-limit keying
      path would be a liability. A new test pins the derived key for all three values across three
      header shapes so this cannot drift again.
- [x] **7.2** Removed the dead `cloudrun` mode from `server/clientIp.js` — `server/config.js`
      rejects the value at boot, so it was unreachable.
- [x] **7.3 `AI_TIMEOUT_MS=0` never disabled the timeout.** `AbortSignal.timeout(0)` fires on
      the next macrotask, so `0` aborted every AI request immediately — verified by running it.
      Now a boot error, along with negatives and non-numerics. Chose an error over the previous
      silent reset to the default: an operator who typos a reliability-relevant timeout should
      find out at boot, not months later.
- [x] **7.4** Boot summary no longer says "open access" for a too-short credential, which was
      exactly backwards — sign-in is closed, not open. Three distinct states now.
- [x] **7.5 The container UID was not 1000.** README and several docs said to chown `./data` to
      UID 1000; the image's user was actually **100**, and UID 1000 belongs to the base image's
      `node` user. Fixed at the root by pinning UID/GID 10001 in the `Dockerfile`, so the
      documented number is guaranteed correct rather than drifting whenever the base image adds a
      system user. README, `deployment.md` and `operations.md` now agree. Image rebuilt and
      verified.
- [x] **7.6** `docs/datastore.md` corrected — it described `CREATE TABLE IF NOT EXISTS`
      migrations; the code uses a versioned migration array keyed on `schema_meta.version`. Three
      further drifts found and fixed while verifying the rest against `schema.js`, including a
      missing table and a wrong claim about when PRAGMAs are applied.
- [x] **7.7** `REQUIRE_HTTPS=1` no longer breaks the Compose healthcheck. The check now sends
      `X-Forwarded-Proto: https`, which is safe because the request originates on the container's
      own loopback. One command covers both configurations.
- [x] **7.8 `AI_MODEL` was effectively required but defaulted to `""`.** Six of seven providers
      reject an empty model, so the default silently guaranteed failure, surfacing as a
      `503 ai_unavailable` at first use rather than at boot. Now a boot error for any non-`mock`
      provider. Note the consequence: `cp .env.example .env && docker compose up` now fails until
      you set `AI_MODEL`, so the README quickstart names both required values and offers
      `AI_PROVIDER=mock` as the zero-setup path.

---

## 7b. What the first CI run found

Standing up CI immediately paid for itself: it surfaced three failures that no local run could
have caught, because the local runs were on **Node 20 — below this project's own
`engines.node: ">=24"` floor** — against a `node_modules` still holding packages removed months
earlier. Worth recording, because it means the suite had never actually been verified on a
runtime the project supports.

- [x] **7b.1 `@types/node` was never a declared dependency.** 132 typecheck errors across 26
      files in CI (`TS2307` on every `node:*` import, `TS2591` on `process`, plus `TS2304` and
      `TS7006`). It had only ever reached `node_modules` two ways: as an *optional peer* of
      vite/vitest, and transitively via an `@types/request` left behind when the Google Cloud
      packages were removed. npm 11 — which CI uses — skips undeclared optional peers, so CI had
      no Node types at all. Compounding it, `tsconfig.json` sets an explicit `types` array, which
      switches off automatic `@types` discovery, so the types were only ever resolving through
      vitest's own type references. Now a real devDependency pinned to `^24` to match the Node
      floor (so a Node 26-only API cannot slip past it), with `"node"` listed explicitly.
      Regenerating the lockfile also dropped the stale `@types/request` tree.
- [x] **7b.2 The test suite was broken on every Node the project supports.** Node 22.4 added the
      Web Storage API. Unlike `sessionStorage`, `localStorage` is file-backed, and its behaviour
      without `--localstorage-file` has already changed twice: **Node 22–25** install the global
      as a stub whose methods are all `undefined`, *shadowing* the one vitest's jsdom environment
      would provide; **Node 26** omits the global entirely and warns instead. That is 173 failures
      across 19 files plus 101 silently skipped tests on 24/25, and a different failure on 26.
      Invisible on Node 20, which has no such global.

      `src/test/webStorageSetup.ts` repairs it by **probing capability rather than matching a
      version's symptoms** — writing a key and reading it back, and substituting a real jsdom
      `Storage` only when that fails. My first attempt tested for the 22–25 symptom specifically
      and so did nothing on 26; the second lesson was to validate the replacement before
      installing it, since assigning an absent `window.localStorage` turned a diagnosable
      condition into a `TypeError` far from its cause.

      A Map-backed shim would not have worked: `SettingsView.tsx:379` sweeps keys with
      `Object.keys(localStorage)` and `syncSettings.persistence.test.ts` walks them with
      `localStorage.key(i)`, both of which need `Storage`'s exotic own-property behaviour. The
      matching `Storage` constructor is published alongside the instances, because that test stubs
      quota errors via `vi.spyOn(Storage.prototype, "setItem")` and the replacements come from a
      second jsdom realm. Chosen over `--no-experimental-webstorage`: that flag has already been
      renamed once (Node 25 lists it as `--webstorage`), and Node exits on an unknown flag, so
      pinning CI to a spelling would fail the suite closed on some future major.
- [x] **7b.3 Tests ran before the build.** `dist/` is gitignored, and `marketing.isolation`,
      `pwa.offline` and `marketing.budget` assert against built output — module graphs, the
      service-worker precache manifest, asset sizes. On a fresh checkout seven failed for want of
      an artifact rather than a bug. This was queued behind the typecheck failure and would have
      surfaced the moment it was fixed. Order is now typecheck → build → test in the workflow and
      in `npm run ci`, with the reason recorded at each site.

Verified from a clean `npm ci` off a source archive, running the full gate on **Node 24.20.0
(npm 11.19)**, **25.9.0 (npm 10.8)** and **26.8.1 (npm 11.19)** — 0 typecheck errors, 82 files /
1161 tests, build clean, `npm run ci` exit 0 on each. CI is green on all three jobs.

`CONTRIBUTING.md` now documents the build-before-test ordering and why a local run needs Node 24+
to mean anything: below it `node:sqlite` is absent and the storage repair never engages, so the
suite quietly tests less than CI does.

---

## 8. Owner decisions — still open

Nothing above is blocked on these. Each needs your call or your credentials.

- [ ] **8.1 Git history.** The four untracked spec folders, `infra/*` (Pulumi + GCP + secret
      wiring) and older `docs/configuration.md` blobs are all still reachable by commit SHA. No
      secret *values* were found, but Stripe and GCP identifiers were adjacent. Untracking stops
      future publication; it does not remove them from existing objects. Decide: leave it, or
      rewrite history before going public. Rotate anything that was ever near those blobs either
      way.
- [ ] **8.2 Commit authorship.** All 121 commits carry `nick.jessop@icloud.com`. It becomes
      public with the repo, and is unavoidable without a rewrite.
- [ ] **8.3 Publish the food pack.** `scripts/fetch-food-pack.mjs` still has a placeholder
      `ARCHIVE_URL` (`github.com/user/food-snap`) and a 64-zero checksum, and hard-exits on the
      placeholder. So there is no way for anyone to obtain the 3,036 illustrations. Needs you to
      upload `food-pack-v1.tar.gz` as a release asset, then fill in both constants. The README
      quickstart currently tells the reader this step is unavailable and to skip it.
- [ ] **8.4 Food pack provenance and license.** The images were generated with Google Imagen via
      `scripts/gen-food-images.mjs`. Nothing states their license, and they ship as a separate
      artifact, so they need their own terms.
- [ ] **8.5 `docs/fodmap-program.md` and `docs/intuitive-eating.md`.** Both are internal design
      and philosophy notes for unbuilt features, with competitor and retention framing.
      Requirement 10.8 bans internal commercial documents; spec Open Decision 10 left this
      unresolved. Publish as-is, rewrite as public design notes, or untrack.
- [ ] **8.6 Naming.** Repo slug is `snap-gut`, package name is `snapgut`, working directory is
      `food-snap`. The product name `SnapGut` is used consistently in the UI and is fine.
      **Do not casually rename the runtime identifiers**: `DB_NAME = "food-snap"` and seven
      `food-snap-*` localStorage keys are a **data migration**, not a rename.
      `src/SettingsView.tsx` already sweeps both prefixes, so a dual-prefix path partly exists.
- [ ] **8.7 Publish a GHCR image** and add `image:` to `docker-compose.yml`, so upgrades are not
      source-only. Tag `v0.1.0`. The CI docker job already proves the image builds.
- [ ] **8.8 `"private": true` in `package.json`.** Harmless for a self-hosted app (it prevents an
      accidental npm publish), contradictory signalling for an OSS repo. Your call.
- [ ] **8.9 No `hosted` branch was ever cut.** The spec Notes assumed one would preserve the
      Cloud Run deployment before the conversion. Only `master` exists, so that deployment's
      history is reachable only by commit SHA.

### Follow-ups noted but out of scope

Stale comments and test fixtures referencing the removed billing and spreadsheet features survive
in `src/db.ts`, `src/session.ts`, `src/syncRoutes.privacy.test.ts`,
`src/marketing.claims.test.ts`, `src/test/syncHarness.ts` and several `cloudSync.*.test.ts` files
(two of which carry their own `// tests will be cleaned up` markers). None is user-visible; all
are comments or fixtures. Worth one more pass, not a blocker.

---

## Spec status, for reference

`.kiro/specs/self-hosted-open-source/tasks.md`: **51 of 51 tasks checked, zero unchecked.** (The
Overview's "42 tasks" is a stale miscount, not missing work.) The conversion itself was already
done. Everything in this document was either publication hygiene the spec did not cover, or one of
four places where the code diverged from its own requirements:

| Requirement | Status at audit | Now |
| --- | --- | --- |
| 6.14 / 7.4 — credential minimum and boot refusal | Not implemented | Fixed (1.8) |
| 5.7 / 5.8 — food pack fetchable | Not possible | Owner action (8.3) |
| 9.10 — LICENSE text, README names the license | Not satisfied | Fixed (1.4, 5.3) |
| 10.8 — no internal commercial documents | Partly | Mostly fixed (1.3); two docs open (8.5) |

`.kiro/specs/native-app-store-launch/tasks.md` has 12 unchecked boxes. They are **not** open
release work — that spec is superseded (StoreKit / Play Billing contradict Requirement 1). It is
now untracked.

Design-vs-code note: `design.md:65` declares a `server/boot.js` module that does not exist; the
five boot phases are inlined into `server/main.js`. Functionally equivalent, but the diagram is
wrong if the design doc ships publicly. Recorded in `docs/architecture.md`.
