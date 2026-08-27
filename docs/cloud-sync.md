# Cloud Sync

How the app keeps two devices in step through the self-hosted server. Written from
`server/sync.js`, `server/eventStore.js`, `src/cloudSync.ts`, `src/syncSettings.ts`,
and `src/backup.ts`.

## How it works

The device is always the source of truth. IndexedDB holds the timeline, everything the app
displays is read from there, and sync is a copy out — never a dependency.

| | Cloud Sync |
| --- | --- |
| Purpose | Multi-device sync and restore after a reinstall |
| Transport | Your own server's `/api/sync/*` endpoints |
| Direction | Two-way (push + pull, with a merge rule) |
| Needs | A session token |
| Photos | Never uploaded — stay on-device |

Sync is off by default. Nothing is enabled by signing in. The app shows you what gets
uploaded before the first sync and will not start syncing without your acknowledgement.

## Endpoints and limits

| Route | Behaviour |
| --- | --- |
| `POST /api/sync/push` | Stores up to 200 records atomically; one outcome per submitted `id` |
| `GET /api/sync/pull` | Up to 500 records per page by ascending sequence, with an opaque cursor |
| `DELETE /api/sync/data` | Deletes the caller's stored records and tombstones; keeps the account |

Bodies are capped at 1 MiB (declared and while streaming), records at 16 KiB each, and
stored records at 100,000 per account. Rate limits are 120 requests per 60 s per IP and
60 per 60 s per account, keyed `sync-ip:` and `sync-user:` in the shared limiter.

Each sync request writes exactly one log line carrying only the method, path, status, record
count, the verified email, a fixed reason code, and — for a caught error — the error's class
name. No event content, note text, or session token can reach a log.

## What is stored where

### On your server, only while Cloud sync is on

In the SQLite database, under the caller's account (cross-account access is structurally
impossible):

- **Events** — one row per entry or deletion marker: `id`, `type`, `createdAt`,
  `updatedAt`, `schemaVersion`, `note` when present, and the type's own fields (`dish` and
  `ingredients`; `symptoms`; `bristol`; `stress`, `sleep`), plus a server-assigned sequence.
  A deletion marker keeps identity and revision only — content fields are stripped.
- **Sync metadata** — the sequence counter and the purge generation.

**Photos are never stored server-side, by two independent mechanisms.** The client's wire
codec has no `photo` field, and the server drops a `photo` key and rejects any payload
carrying photo-shaped data with `400 photo_field`.

The account record itself — `{ email, created_at }` — exists for every account, sync or
not. See `docs/datastore.md`.

### On the device, always

IndexedDB `food-snap` v3:

- `events` — entries and deletion markers, meal photos among them as `Blob`s.
- `outbox` — ids waiting for the next push.
- `meta` — the sync cursor and sync timestamps.

Meal photos exist only here and in a backup file the user saves themselves. Everything the
app computes — patterns, food ranking, statistics — is computed here and needs no network.

Separately from sync, a meal photo is transmitted for recognition (`/api/recognize`) and is
not persisted on the server.

## Export

Always available, no network needed. From Settings:

- **Backup** — one JSON file with the whole timeline, photos inlined as base64 data URLs.
  Deletion markers are not included. The same screen restores from a file.
- **Export as CSV** — datetime, type, dish, confident ingredients, maybe ingredients,
  symptoms, bristol, stress, sleep, note.

## Deletion

Three paths:

1. **The cloud copy** — `DELETE /api/sync/data`. Removes every stored record and deletion
   marker for the caller and bumps the purge generation, so every previously issued cursor
   is reported invalid. On success the client disables the destination, resets the cursor,
   clears the outbox, and leaves every local entry and photo alone. A purge that fails or
   outruns its 30-second deadline answers `500 delete_incomplete` and changes nothing else,
   so the request can simply be repeated — deletion is idempotent.
2. **The account** — `POST /api/account/delete`. Purges stored events first, then removes
   the account record. Any failure is reported as incomplete with nothing else changed.
   On success the client deletes the whole IndexedDB database (timeline, outbox, cursor)
   and sweeps the `food-snap*` and `snapgut*` local-storage keys.
3. **On-device data** — delete individual entries in the app, or clear the site's data in
   the browser. Entirely local.

Retention after deletion of the cloud copy is none — only data the user explicitly pushes
is stored, and deletion removes it completely.
