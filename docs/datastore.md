# Datastore — SQLite Schema Reference

The server persists all data in a single SQLite file at the path given by `DB_PATH` (default:
`/data/snapgut.db`). The schema is applied automatically on first boot and on every subsequent
start by the `migrate()` function in `server/sqlite/schema.js`.

## PRAGMAs

`migrate()` applies these, in this order, before it looks at the schema version — so they are set
once per process, at boot phase 3, by the same call that runs migrations. `openDatabase()` in
`server/sqlite/open.js` only resolves the path and opens the file; it sets no PRAGMAs of its own.

| PRAGMA | Value | Purpose |
| --- | --- | --- |
| `journal_mode` | `WAL` | Concurrent readers and crash-safe writes |
| `foreign_keys` | `ON` | Enforce referential integrity |
| `busy_timeout` | `5000` | Wait up to 5 seconds for a write lock rather than failing immediately |

`journal_mode = WAL` is set outside any transaction because SQLite will not change the journal
mode inside one. That is why the PRAGMAs sit above the migration loop rather than inside a
migration.

## Tables

Six tables. Five hold data; `schema_meta` records which migrations have run.

### `schema_meta`

The migration bookkeeping table, and the thing `migrate()` reads to decide what still needs
applying. One row today: `('version', '1')`.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `key` | TEXT | PRIMARY KEY | Metadata key — only `version` is used |
| `value` | TEXT | NOT NULL | The value, stored as text; the version is parsed with `Number()` |

Its absence from `sqlite_master` is how `migrate()` recognises an empty database, so do not drop
it — a database without it is treated as brand new and the version 1 migration is attempted
again, which fails on the tables that already exist.

### `users`

The account record. It holds only the email and a creation timestamp — no profile fields, no
plan or usage counters, nothing about the person beyond the address they sign in with.

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

Records marked as deleted (`deleted = 1`) are retained for 180 days (`TOMBSTONE_RETENTION_MS` in
`server/eventStore.js`) so that other devices can learn about the deletion during sync. After 180
days they are swept — deleted from the `events` table — on the next `pull` or `countFor` call for
that account, and `sync_meta.last_tombstone_sweep_at` records when that happened.

The sweep deletes rows where `deleted = 1 AND updated_at IS NOT NULL AND updated_at < now -
180 days`, using the `events_sweep` index. A tombstone whose `updated_at` is null is never swept,
and a record that is not a tombstone is never touched. Retention is therefore a floor rather than
an exact expiry: a tombstone survives until something asks that account for data after it has
genuinely aged past 180 days.

## Migrations

`server/sqlite/schema.js` holds an ordered array of migrations, each entry `{ version, up(db) }`.
`migrate(db)` applies every pending one, forward-only — there are no down migrations.

The mechanism, step by step:

1. Apply the PRAGMAs above (outside any transaction).
2. Read the current version: look for a `schema_meta` table in `sqlite_master`, and if it is
   there, read `value` from the row where `key = 'version'`. A missing table, a missing row, or an
   unparseable value all resolve to version `0`.
3. Walk the migration array in order and, for each entry whose `version` is greater than the
   current version, run `BEGIN`, call `up(db)`, then `COMMIT`. A throw triggers `ROLLBACK` and is
   re-raised, which fails the boot.

Each migration owns its own transaction rather than the whole run sharing one, so a failure part
way through a multi-migration upgrade leaves the earlier migrations applied and the version row
reflecting them. That is what makes a retry after fixing the cause pick up where it stopped.

There is exactly one migration today, version 1, which creates every table and index above and
inserts `('version', '1')` into `schema_meta` as its last statement — inside the same transaction,
so a database can never end up with the tables but no version row.

The statements are plain `CREATE TABLE` and `CREATE INDEX`, **not** `CREATE TABLE IF NOT EXISTS`.
Idempotence comes from the version check, not from the DDL: `migrate()` on an already-initialised
database reads version 1, finds nothing pending, and does no work. Re-running the version 1
migration against populated tables would fail, which is the point — it means a lost or corrupted
`schema_meta` is a loud failure rather than a silent one.

Adding a table or column means appending a new `{ version: 2, up(db) }` entry and having it write
`UPDATE schema_meta SET value = '2' WHERE key = 'version'`. Never edit the version 1 migration;
existing databases have already run it and will not run it again.

On upgrade, the server applies any new migrations automatically at boot. The recommended
practice is to back up the database file before upgrading — see the README's upgrade section.

## Backup and restore

The database is a single file at `DB_PATH`. To back up:

1. Stop the server (or use `sqlite3 /path/to/snapgut.db ".backup /path/to/backup.db"`).
2. Copy the `.db` file and any `-wal` / `-shm` files alongside it.

To restore, stop the server, replace the database file with the backup, and start the server.
