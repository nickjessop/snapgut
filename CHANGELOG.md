# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING: `/` now serves the app.** SnapGut is self-hosted software, so an instance no longer
  ships a product landing page. The origin root, `/login`, `/app` and `/app/*` are all answered
  with the one app-shell document, and `/` is served directly rather than redirected to `/app` —
  a redirect cannot come from the service-worker cache, so this is what makes a launch from the
  bare host work offline. The client router treats `/` as an alias of the default view and
  rewrites the address to `/app` in place with `history.replaceState`, so no history entry is
  added and pressing Back from `/` leaves the app.
- `robots.txt` is now unconditionally `User-agent: *` / `Disallow: /`, and `X-Robots-Tag: noindex`
  is sent on every response whatever `PUBLIC_ORIGIN` is set to. There is no indexable surface
  left, and a self-hosted health diary should not be in a search index.
- `PUBLIC_ORIGIN` is now declarative only. It used to switch on the sitemap, permissive
  `robots.txt` rules, and canonical/`og:url` tags; none of those exist any more. The variable is
  still read and validated, so no `.env` change is needed.

### Removed

- **BREAKING: `/privacy` and `/terms` now return 404.** Anyone who bookmarked either page will
  get the not-found document. Their substance — what stays on the device, what the server's
  SQLite file holds, what leaves the machine for the AI provider, the export formats, the three
  deletion paths, the not-a-medical-device framing, and the operator's responsibilities — is
  preserved as [`docs/privacy.md`](docs/privacy.md) and [`docs/terms.md`](docs/terms.md), with the
  account-record description corrected to match the single-local-credential auth model.
- **BREAKING: `/sitemap.xml` now returns 404.** No sitemap is built; there is nothing to
  enumerate.
- The `marketing/` sources, the marketing build plugins (`vite/marketing.js`, `vite/partials.js`),
  and the now-unreferenced marketing illustrations and Open Graph card from `public/`. The
  marketing pages move to a separate website repository.
- The not-found document is now a self-contained `404.html` at the repository root with inline
  styles, instead of a marketing-styled page built from shared partials. It is still served with
  status 404 and is still never the app shell.

## [0.1.0] - unreleased

First open-source release of SnapGut. The tag has not been cut yet, so this entry has no date.

### Added

- Self-hosted food and symptom diary: capture a meal photo, log gut symptoms, and review which
  foods track with symptoms over time.
- Single-file SQLite datastore using Node's built-in `node:sqlite`. All diary data lives in one
  file under `DATA_DIR`, so backup is a file copy.
- Pluggable AI providers selected by `AI_PROVIDER`: `ollama` (default, local), `openai`,
  `openai-compatible`, `litellm`, `anthropic`, `gemini`, and `mock`. The default keeps meal photos
  and prompts on the host.
- Single-credential authentication via `AUTH_PASSWORD`, with HMAC-SHA256 session tokens and a
  session secret generated into `${DATA_DIR}/session-secret` on first run when unset.
- Offline-capable PWA client with on-device photo storage, so the diary keeps working without a
  network connection.
- Optional multi-device sync through the operator's own server. No third-party sync service is
  involved.
- Local food illustration pack of 3,036 images, fetched separately and served from the host.
  Skipping it falls back to letter avatars.
- Docker and Docker Compose deployment as the supported install path, plus configuration entirely
  through environment variables documented in `.env.example` and `docs/configuration.md`.
- Multi-architecture container image published to GitHub Container Registry for tagged releases,
  built for `linux/amd64` and `linux/arm64` so Raspberry Pi and Apple silicon hosts run a native
  image without compiling anything. Each release is tagged three ways — exact (`0.1.0`), minor
  (`0.1`) and `latest` — and `docker-compose.yml` builds from source by default, with the image
  as a commented one-line alternative. See `docs/deployment.md`.

### Removed

- Everything tied to the previous hosted service: billing and subscription handling, usage
  telemetry and analytics, spreadsheet sync, and the cloud infrastructure it ran on. What remains
  runs on hardware the operator controls.
