# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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

### Removed

- Everything tied to the previous hosted service: billing and subscription handling, usage
  telemetry and analytics, spreadsheet sync, and the cloud infrastructure it ran on. What remains
  runs on hardware the operator controls.
