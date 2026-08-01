# Sync destinations: SnapGut Cloud and Google Sheets

What the shipped code does with a user's log when they switch sync on. Written from
`server/sync.js`, `server/eventStore.js`, `server/index.js`, `src/db.ts`, `src/cloudSync.ts`,
`src/syncSettings.ts`, `src/googleSheets.ts`, `src/backup.ts`, and `src/SettingsView.tsx` — not
from the specs' intentions. `marketing/privacy.html` draws on this document; the disagreements
between the two are listed at the end rather than smoothed over.

Both features are built and in the repo. `.kiro/specs/cloud-sync/` and
`.kiro/specs/google-sheets-integration/` are the completed specs; `docs/datastore.md` covers the
Firestore collections outside sync, and `docs/google-sheets-sync.md` the Sheets design.

## Two destinations, genuinely independent

The device is always the source of truth. IndexedDB holds the timeline, everything the app
displays is read from there, and sync is a copy out — never a dependency.

| | SnapGut Cloud | Google Sheets |
| --- | --- | --- |
| Purpose | multi-device sync and restore after a reinstall | a readable mirror in the user's own Drive |
| Transport | our `/api/sync/*` endpoints | Google's Sheets/Drive REST APIs, called from the browser |
| Our servers see | every non-photo field of every entry | nothing — no request touches our backend |
| Direction | two-way (push + pull, with a merge rule) | one-way mirror, plus an explicit re-import |
| Needs | a Session_Token | `VITE_GOOGLE_CLIENT_ID` at build time, and a spreadsheet id |
| Photos | never uploaded | not representable in a row |

Independence is structural, not a convention. `src/syncSettings.ts` persists one boolean per
destination (`snapgut-sync-cloud-enabled`, `snapgut-sync-sheets-enabled`); both default to
`false`, any non-`true` stored value reads as disabled, and `setDestinationEnabled` writes only
its own key. All four on/off combinations are reachable, and neither destination's state, cursor,
or credentials can disturb the other's. Nothing is enabled by default and nothing is enabled by
signing in.

The one thing the two share is the Pro gate below.

## The Pro gate

Server-side for Cloud. Step 6 of the `/api/sync/*` middleware chain reads the authenticated
user's own record and evaluates entitlement against the server clock; any entitlement the client
sends is ignored. A non-Pro caller gets `402 { "error": "upgrade_required", entitlement }` before
any stored event is read or written. `401` for a missing or invalid Session_Token takes
precedence over `402`. Every sync response — success or refusal — carries the server's
`entitlement` snapshot, which is how the client's gate stays fresh.

**One exception: `DELETE /api/sync/data` is authenticated but not entitlement-gated.** A lapsed
user's cloud copy is retained indefinitely (there is no lapse purge), so this request is the only
way it is ever removed; a `402` here would trap data the user asked us to delete.

Client-side for both. `isProEntitled()` reads the persisted entitlement snapshot and returns
`false` when none exists, so a cold start before the first server response is treated as not Pro.
A destination only counts as active when it is enabled *and* configured *and* entitled *and* not
in the 72-hour failing state.

The Sheets Pro gate is client-side only — there is no server in that path to enforce one. It
gates our UI and our sync triggers, not the user's own Drive.

Enabling Cloud sync also requires acknowledging an in-app disclosure of what gets uploaded
(`DISCLOSURE_VERSION`, persisted per identity). The first enable cannot complete without it.

## Endpoints and limits

| Route | Behaviour |
| --- | --- |
| `POST /api/sync/push` | Stores up to 200 Event_Records atomically; one outcome per submitted `id` |
| `GET /api/sync/pull` | Up to 500 records per page by ascending sequence, with an opaque cursor |
| `DELETE /api/sync/data` | Deletes the caller's stored records and tombstones; keeps the account |

HTTPS is required. Bodies are capped at 1 MiB (declared and while streaming), records at 16 KiB
each, and stored records at 100,000 per user. Rate limits are 120 requests per 60 s per IP and
60 per 60 s per user, keyed `sync-ip:` and `sync-user:` in the shared limiter.

Each sync request writes exactly one log line carrying only the method, path, status, record
count, the verified email, a fixed reason code, and — for a caught error — the error's class
name. No event content, note text, or Session_Token can reach a log, and there is no analytics or
crash-reporting destination.

## What is stored where

### On our servers, only while Cloud sync is on

Under the caller's own user document (`users/{email}/…`, so cross-user access is structurally
impossible):

- `events/{id}` — one document per entry or deletion marker: `id`, `type`, `createdAt`,
  `updatedAt`, `schemaVersion`, `note` when present, and the type's own fields (`dish` and
  `ingredients`; `symptoms`; `bristol`; `stress`, `sleep`), plus a server-assigned sequence.
  A deletion marker keeps identity and revision only — `note`, `dish`, `ingredients`,
  `symptoms`, `bristol`, `stress`, and `sleep` are all stripped.
- `sync/meta` — the sequence counter and the purge generation.

**Photos are never stored server-side, by two independent mechanisms.** The client's wire codec
has no `photo` field, and the server drops a `photo` key and rejects any payload carrying
photo-shaped data (a data URL, or a long base64 run, nested included) with `400 photo_field`.

The account record itself — `{ email, pro, proUntil, freeAiUsed, stripeCustomerId, createdAt }` —
exists for every account, sync or not. See `docs/datastore.md`.

### On the device, always

IndexedDB `food-snap` v3:

- `events` — entries and deletion markers, meal photos among them as `Blob`s.
- `outbox` — ids waiting for the next push.
- `meta` — the sync cursor and sync timestamps.

Meal photos exist only here and in a backup file the user saves themselves. Everything the app
computes — patterns, food ranking, statistics — is computed here and needs no network.

Separately from sync, a meal photo is transmitted for recognition (`/api/recognize`) and is not
persisted on our side.

## Export

Free on every account, never behind Pro, and no network needed. From Settings:

- **Backup** — one JSON file with the whole timeline, photos inlined as base64 data URLs.
  Deletion markers are not included. The same screen restores from a file.
- **Export as CSV** — datetime, type, dish, confident ingredients, maybe ingredients, symptoms,
  bristol, stress, sleep, note.

The Sheets mirror uses those same columns plus an `id` column, which is what makes a row
re-importable.

## Deletion

Four paths, none of which requires contacting us.

1. **The cloud copy** — `DELETE /api/sync/data`. Removes every stored record and deletion marker
   for the caller and bumps the purge generation, so every previously issued cursor is reported
   invalid and a device holding one re-enqueues its timeline instead of skipping records. Works
   without Pro. On success the client disables the destination, resets the cursor, clears the
   outbox, and leaves every local entry and photo alone. A purge that fails or outruns its
   30-second deadline answers `500 delete_incomplete` and changes nothing else, so the request
   can simply be repeated — deletion is idempotent.
2. **The account** — `POST /api/account/delete`. Purges stored events *first*, then removes the
   user record and any pending sign-in code. Deleting the user record first would orphan the
   events behind an entitlement check that no longer passes. Any failure is reported as
   incomplete with nothing else changed.
   On success the client deletes the whole IndexedDB database (timeline, outbox, cursor), sweeps
   the `food-snap*` and `snapgut*` local-storage keys, switches the Sheets destination off, and
   drops the stored spreadsheet id. It writes nothing to Google, so the spreadsheet stays in the
   user's Drive.
3. **On-device data** — delete individual entries in the app, or clear the site's data in the
   browser. Entirely local.
4. **The spreadsheet** — the user's own file in their own Drive. Disconnecting leaves it there;
   deleting it is between them and Google.

Retention after a Pro lapse is indefinite for the cloud copy. There is no retention window and
no automatic purge; only a deletion the user asks for empties it.

## Google Sheets specifics

One spreadsheet titled "Food Snap Data", created once in the user's Drive under the `drive.file`
scope — the app can reach only the file it created. Rows are upserted by event id, so repeated
syncs converge rather than duplicating. Auth is a short-lived in-browser Google Identity Services
token; there is no refresh token and no server-side component, so syncing happens only while the
app is open.

In production the destination is currently inert: `VITE_GOOGLE_CLIENT_ID` is not set at build
time (it is absent from the `Dockerfile` and from the infra stack config), so `isSheetsEnabled()`
is false in the shipped bundle and the Settings controls are hidden. Setting the variable at
build time is all that turns it on, and public use would also need Google OAuth verification.

## Where `marketing/privacy.html` and the code disagree

Reported, not edited — resolving these is a copy decision.

1. **"All we hold about you is your email address and whether Pro is active."** In the page's
   short-version list, unqualified. With Cloud sync on we also hold every non-photo field of
   every entry, including note text, plus deletion markers. The later "Where your log syncs"
   section says so plainly, and a neighbouring bullet says nothing syncs unless the user switches
   it on, so the page contradicts itself rather than the code. The bullet needs a conditional.
2. **"There are two destinations you can switch on … in Settings."** True of the code, not of the
   shipped build: with `VITE_GOOGLE_CLIENT_ID` unset there is no Sheets control to switch on.
   Either set the variable or qualify the page.
3. **"Both are part of Pro."** True, but the two gates are not equivalent: Cloud is refused by
   the server, Sheets only by the client. Accurate as user-facing copy; worth knowing it is not a
   server-enforced statement for Sheets.
4. **"A one-time sign-in code … deleted the moment you use it."** True of a completed sign-in. An
   *abandoned* one leaves a document holding the email address and the code's hash with no
   expiry — one per address, overwritten on each request. See the `authCodes` note in
   `docs/datastore.md`.
