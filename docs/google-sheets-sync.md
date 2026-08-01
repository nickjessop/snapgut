# Google Sheets Sync — Design & Plan

Goal: let users save + sync their log to a Google Sheet in their own Drive. It's the
lowest-friction "cloud backup" for most people, and an alternative to relying only
on local storage. When enabled, we keep storing locally (local stays the source of
truth) and turn off the backup reminders.

Status: **built and shipped** (`src/googleSheets.ts`), but inert in production until
`VITE_GOOGLE_CLIENT_ID` is set at build time; it is not set today. Requires user-side
OAuth setup (below). It is one of two independent sync destinations — the other is
SnapGut Cloud, which also shipped. `docs/cloud-sync.md` describes both, the Pro gate
they share, what each stores, and the deletion paths.

This document is the design and the setup guide. Where it and the code differ, the code
and `docs/cloud-sync.md` win.

---

## How it works

```
App (local-first, IndexedDB = source of truth)
  → "Connect Google Sheets" → Google sign-in (OAuth via Google Identity Services)
  → app creates ONE spreadsheet ("Food Snap Data") in the user's Drive
  → on save / app-open / "Sync now", push the timeline as rows (upsert by event id)
  → while connected: suppress backup reminders, keep storing locally
```

The sheet is a live, human-readable mirror the user owns. Local remains primary and
fully offline-capable; the sheet is the durable copy + easy export.

## Key decisions

### 1. One-way mirror vs two-way sync — **recommend one-way**
- **One-way (app → Sheet) + re-import**: app writes the log to the sheet; sheet is a
  readable backup that can also be re-imported. Simple, robust, no conflict handling.
- **Two-way / multi-device merge**: editing on multiple devices and merging is hard
  over Sheets (conflict resolution, delete detection); Sheets isn't built for it.
  That is what SnapGut Cloud does instead, and it is **built** — `/api/sync/*` over
  Firestore, with a total merge rule and deletion markers (`docs/cloud-sync.md`). It is
  no longer future work, so this decision stands as shipped: Sheets remains the one-way
  readable mirror, Cloud does multi-device.

### 2. Photos are NOT synced to Sheets
Sheets can't hold image files (only a URL via the `IMAGE()` formula). So the sheet
carries structured data only (same columns as our CSV: datetime, type, dish,
confident/maybe ingredients, symptoms, bristol, stress, sleep, note). Photos stay
local. Backing up photos would require Google Drive (extra scope) — a later add-on.

### 3. OAuth scope + verification — **use `drive.file`**
- `drive.file` = app can only access the single spreadsheet it creates, nothing else
  in the user's Drive. Least-scary consent, lightest verification path.
- Testing mode (self + a few test users): works immediately, no verification.
- Public release to arbitrary users: requires Google **OAuth app verification**
  (privacy policy, homepage, consent-screen review). Process takes days; plan ahead.
- Avoid the full `spreadsheets`/`drive` scopes (sensitive/restricted → heavier review).

## Token handling
- In-browser **Google Identity Services (GIS)** token flow yields a short-lived
  (~1h) access token. Fine while the app is open; GIS can re-issue silently
  (`prompt: 'none'`) when needed.
- No durable background sync on a PWA (esp. iOS) anyway — sync happens when the app
  is open. If we later want server-side/background sync with refresh tokens, do the
  auth-code flow on Cloud Run and store tokens in Secret Manager.

## Data model → rows
Each event = one row keyed by its `id` (upsert). Columns mirror `toCSV()` in `db.ts`,
so the existing CSV serializer can be largely reused. Header row written on create.

## Behavior when connected
- Suppress the backup reminder nudge (still allow manual JSON backup/export).
- Show status: "Synced to Google Sheets · last synced X".
- "Sync now" button; auto-sync on save and on app open.
- Disconnect option (revokes token locally, keeps the sheet).

## What the user must set up (Google Cloud Console, ~10 min)
1. Enable **Google Sheets API** and **Google Drive API**.
2. Create an **OAuth 2.0 Client ID** (type: Web application); add app origin(s) to
   authorized JavaScript origins (e.g. the Cloud Run URL + `http://localhost:5173`).
3. Configure the **OAuth consent screen**; add yourself/testers as test users.
4. Provide the **client ID** to the app (env/config).

## What was built
- `src/googleSheets.ts`: GIS init, connect/disconnect, ensure-spreadsheet (create once,
  store spreadsheet id locally), `syncAll` (upsert rows by id), re-import, the CSV
  columns plus an appended `id` column.
- Settings: connect, status line, "Sync now", re-import, disconnect — all hidden while
  no client ID is configured, and non-interactive while Pro is off.
- The enabled flag, the Pro gate, and the backup-nudge suppression moved to
  `src/syncSettings.ts`, shared with the Cloud destination.
- Config: `VITE_GOOGLE_CLIENT_ID`, build-time, inert until set — and unset in the
  production image today.

## Shipped shape
One-way mirror · `drive.file` scope · structured data only (no photos) · local stays
primary · reminders off while a destination is active · Pro-gated client-side.
Multi-device editing is SnapGut Cloud's job, not this one.

## Open questions
- [ ] Set `VITE_GOOGLE_CLIENT_ID` in the production build, or leave the destination
      inert? Public use also needs Google OAuth verification.
- [ ] Later: sync photos via Drive? (extra scope + storage considerations)
