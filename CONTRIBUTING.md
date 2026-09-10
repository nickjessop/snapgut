# Contributing to SnapGut

Thanks for taking an interest. SnapGut is a self-hosted food and symptom diary, and it is
maintained in spare time. Bug reports, documentation fixes, and focused pull requests are all
welcome. If you are planning something large, open an issue first so we can agree on the shape
before you write the code.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js 24+** | Required. The server uses the built-in `node:sqlite` module. |
| **Docker** (with Compose) | Optional. Only needed to test the container deployment. |

No model server and no API key are needed to develop against SnapGut — see the `mock` provider
below.

## Getting set up

```bash
git clone https://github.com/nickjessop/snap-gut.git
cd snap-gut
npm install
cp .env.example .env
```

Edit `.env` and set two values:

- `AUTH_PASSWORD` — at least 12 characters. Without it, sign-in is disabled.
- `AI_PROVIDER=mock` — returns synthetic recognition and insight data with no network call, so
  you need neither a local model server nor a third-party API key.

Every other setting has a working default. The full list lives in `.env.example` and
`docs/configuration.md`.

## Running it

```bash
npm run dev                              # Vite dev server + API together (the usual choice)
npm start                                # API server alone, no client rebuild
node --env-file=.env server/main.js      # API server with .env loaded by Node
```

`npm start` does not read `.env` on its own — Node only loads an env file when you pass
`--env-file`. Use the third form when you want the server alone with your local configuration.

## Checks a change must pass

One command runs everything CI runs, in the order CI runs it:

```bash
npm run ci
```

That is `typecheck`, then `build`, then `test`. Individually:

```bash
npm run typecheck # tsc --noEmit
npm run build     # vite production build
npm test          # vitest, the whole suite
```

**Build before you test.** `dist/` is gitignored, and a few tests assert against the built
output — `serverRoutes.test.ts` drives the real Hono app against the documents and static files
the build emits, and `pwa.offline.test.ts` runs the generated `dist/sw.js` and checks its
precache manifest. Both rebuild for themselves when `dist/` is missing or stale, but that is a
fallback, not the intended order. For the same reason, rebuild after changing anything under
`app/`, `public/`, `vite/`, or `404.html`, or those tests will be measuring a stale `dist/`.

Node 24 or newer is required, and not only by `engines`. Below it the suite gives misleading
results: `node:sqlite` does not exist, so the SQLite tests cannot run, and Node's own
`localStorage` global — the thing `src/test/webStorageSetup.ts` repairs — is absent, so you
will not exercise what CI exercises.

## Project layout

| Path | Contents |
| --- | --- |
| `server/` | Hono API and boot sequence. `server/main.js` is the sole entry point. |
| `server/ai/` | Pluggable AI provider adapters, one file per provider. |
| `server/sqlite/` | SQLite datastore. |
| `src/` | React 18 PWA client (TypeScript) and the test suite. |
| `shared/` | Route table shared between client and server. |
| `vite/` | Custom build plugins. |
| `app/` | The app-shell document, served at `/`, `/login`, `/app` and `/app/*`. |
| `public/` | Copied verbatim into `dist/`: icons, favicons, `robots.txt`. |
| `brand/` | Brand assets and icon sources. |
| `docs/` | Documentation. |
| `food-pack/` | 3,036 food illustrations, gitignored and fetched separately. |

## `server/` is JavaScript on purpose

The server is plain ESM JavaScript with JSDoc types. It runs directly under Node with no build
step, which keeps the deployment simple and the stack traces honest. `npm run typecheck` still
checks it through JSDoc. Please do not send pull requests that convert `server/` to TypeScript;
they will be declined regardless of quality.

The client (`src/`) is TypeScript. Keep new client code typed.

## Adding an AI provider

Providers are selected by the `AI_PROVIDER` env var. To add one:

1. Create the adapter in `server/ai/`, following the shape of an existing file such as
   `server/ai/ollama.js`.
2. Register it in `server/ai/index.js`: add the name to the `SUPPORTED_PROVIDERS` list and add a
   `case` to the `createAiProvider` switch.
3. Add the name to `VALID_AI_PROVIDERS` in `server/config.js`.
4. Add any new env vars to `.env.example`. `src/envExample.test.ts` enforces a bidirectional
   match between the variables `server/config.js` reads and the lines in `.env.example`, so a
   missing entry on either side fails the suite.
5. Document the provider in `docs/configuration.md` and in the README provider table, including
   whether data leaves the host.
6. Add a request-shape test to `src/ai.adapters.test.ts` covering the URL, headers, and body the
   adapter produces, including the image and JSON-mode fields.

## Testing conventions

Tests run under vitest and live next to the source in `src/`, named `*.test.ts` or
`*.test.tsx`. Two conventions matter:

```ts
// @vitest-environment node
```

Put that at the top of any test that exercises server code, so it runs under Node rather than
jsdom.

```ts
// @ts-ignore -- untyped ESM JavaScript
import { createOllamaProvider } from "../server/ai/ollama.js";
```

Server modules are untyped from TypeScript's point of view, so imports from `../server/*.js`
need that comment directly above them.

## Pull requests

- One concern per pull request. Split unrelated changes.
- Behaviour changes need tests. Bug fixes need a test that fails before the fix.
- No unrelated reformatting. It buries the actual change in diff noise.
- Describe what you tested, not just what you changed. Say which provider and which deployment
  path you exercised if it is relevant.
- Update `docs/` and `.env.example` when behaviour or configuration changes.

## Security

Do not open a public issue for anything security-related. See [SECURITY.md](SECURITY.md) for the
private reporting channel. SnapGut stores personal health data, so a quiet fix first is better
for the people running it.

## Licensing

SnapGut is licensed under AGPL-3.0-or-later. By contributing, you agree that your contribution
is licensed under the same terms. There is no separate contributor licence agreement.
