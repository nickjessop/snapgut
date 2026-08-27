# Datastore — SQLite Schema Reference

The server persists all data in a single SQLite file at the path given by `DB_PATH` (default:
`/data/snapgut.db`). The schema is applied automatically on first boot and on every subsequent
start by the `migrate()` function in `server/sqlite/schema.js`.

## PRAGMAs

Applied on every connection open:

| PRAGMA | Value | Purpose |
| --- | --- | --- |
| `journal_mode` | `WAL` | Concurrent readers and crash-safe writes |
| `foreign_keys` | `ON` | Enforce referential integrity |
| `busy_timeout` | `5000` | Wait up to 5 seconds for a write lock rather than failing immediately |

## Tables

### `users`

The account record. After the self-hosted conversion this holds only the email and a creation
timestamp — no profile fields, no entitlement, no usage counters.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `email` | TEXT | PRIMARY KEY | Normalised email address |
| `created_at` | INTEGER | NOT NULL | Unix timestamp (ms) when the account was created |

### `rate_limits`

Fixed-window counters for brute-force protection on sign-in and sync endpoints.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `key` | TEXT | NOT NULL, part of PK | Limit identifier (e.g. `auth-ip:127.0.0.1`, `sync-user:user@example.com`) |
| `bucket` | INTEGER | NOT NULL, part of PK | Window bucket: `floor(now / windowMs)` |
| `count` | INTEGER | NOT NULL | Number of requests in this window |
| `expires_at` | INTEGER | NOT NULL | Unix timestamp (ms) after which this row can be swept |

- `WITHOUT ROWID` table with composite primary key `(key, bucket)`.
- Expired rows are swept piggybacked on each `rateLimit()` call — rows whose `expires_at` is
  more than two windows in the past are deleted.

**Index:**

| Name | Columns | Purpose |
| --- | --- | --- |
| `rate_limits_expires` | `expires_at` | Efficient sweep of expired rows |

### `missing_foods`

Coverage tally: which logged foods have no illustration yet, so the next generation batch knows
what to draw. Written fire-and-forget from the recognition annotator and the food-pack 404
handler. Aggregate only — never linked to a user.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `slug` | TEXT | PRIMARY KEY | Canonical food slug |
| `reason` | TEXT | NOT NULL | Why it is missing: `no_image` or `unknown` |
| `count` | INTEGER | NOT NULL | How many times it has been requested |
| `last_seen` | INTEGER | NOT NULL | Unix timestamp (ms) of the most recent request |

- `WITHOUT ROWID` table.

### `sync_meta`

Per-account bookkeeping for the cloud-sync protocol: the current sequence counter and purge
epoch.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `email` | TEXT | PRIMARY KEY, FK → `users(email) ON DELETE CASCADE` | Account identifier |
| `seq` | INTEGER | NOT NULL, DEFAULT 0 | Highest sequence number assigned to an event for this account |
| `epoch` | INTEGER | NOT NULL, DEFAULT 1 | Purge generation — incremented on `deleteAll`, invalidating previously issued cursors |
| `last_tombstone_sweep_at` | INTEGER | nullable | Unix timestamp (ms) of the last expired-tombstone sweep |

### `events`

The event store: one row per sync record (meal, symptom, or tombstone) per account. The
`record` column holds the full wire-format JSON; other columns are denormalised for indexing.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `email` | TEXT | NOT NULL, part of PK | Account identifier |
| `id` | TEXT | NOT NULL, part of PK | Client-generated record identifier |
| `seq` | INTEGER | NOT NULL | Monotonically increasing sequence number within the account |
| `clamped_from` | INTEGER | nullable | Original `updatedAt` value if it was clamped (future clock) |
| `deleted` | INTEGER | NOT NULL, DEFAULT 0 | `1` if this is a tombstone, `0` otherwise |
| `updated_at` | INTEGER | nullable | Denormalised copy of the record's `updatedAt` for sweep indexing |
| `record` | TEXT | NOT NULL | The complete record as key-sorted JSON |

- `WITHOUT ROWID` table with composite primary key `(email, id)`.
- The `record` column is the source of truth. `deleted` and `updated_at` are denormalised
  copies that exist solely to support indexed queries — they are never read as authoritative.

**Indexes:**

| Name | Columns | Purpose |
| --- | --- | --- |
| `events_seq` | `(email, seq)` | Cursor-based pagination on pull |
| `events_sweep` | `(email, deleted, updated_at)` | Efficient tombstone expiry sweep |

## Cursors

The sync cursor format is `"{epoch}:{seq}"` — two decimal integers separated by a colon,
matched by `/^(\d+):(\d+)$/`. A cursor is invalid when it fails the pattern, exceeds the
safe-integer range, or carries an epoch other than the account's current one. `deleteAll`
increments the epoch and resets seq to 0, which invalidates every previously issued cursor.

## Tombstone sweep

Records marked as deleted (`deleted = 1`) are retained for 180 days (the tombstone retention
period) so that other devices can learn about the deletion during sync. After 180 days they
are swept — deleted from the `events` table — on the next `pull` or `countFor` call for that
account.

## Migrations

Migrations are forward-only (no down migrations). The schema uses `CREATE TABLE IF NOT EXISTS`
and `CREATE INDEX IF NOT EXISTS`, making `migrate()` idempotent: re-running on an already-
initialised database is a no-op.

On upgrade, the server applies any new migrations automatically at boot. The recommended
practice is to back up the database file before upgrading — see the README's upgrade section.

## Backup and restore

The database is a single file at `DB_PATH`. To back up:

1. Stop the server (or use `sqlite3 /path/to/snapgut.db ".backup /path/to/backup.db"`).
2. Copy the `.db` file and any `-wal` / `-shm` files alongside it.

To restore, stop the server, replace the database file with the backup, and start the server.
