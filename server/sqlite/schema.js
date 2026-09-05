/**
 * SQLite schema and migration system for the self-hosted datastore.
 *
 * Uses `node:sqlite` (Node 24's built-in DatabaseSync class).
 * The `migrate(db)` function is idempotent — safe to call on every boot.
 * It reads `schema_meta.version` to decide which migrations still need to run,
 * and applies each pending migration inside its own transaction.
 */

// ---------------------------------------------------------------------------
// Migration definitions — ordered array, each entry is { version, up(db) }
// ---------------------------------------------------------------------------

const migrations = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE schema_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE users (
          email      TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE rate_limits (
          key        TEXT    NOT NULL,
          bucket     INTEGER NOT NULL,
          count      INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (key, bucket)
        ) WITHOUT ROWID;

        CREATE INDEX rate_limits_expires ON rate_limits (expires_at);

        CREATE TABLE missing_foods (
          slug      TEXT PRIMARY KEY,
          reason    TEXT    NOT NULL,
          count     INTEGER NOT NULL,
          last_seen INTEGER NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE sync_meta (
          email                   TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
          seq                     INTEGER NOT NULL DEFAULT 0,
          epoch                   INTEGER NOT NULL DEFAULT 1,
          last_tombstone_sweep_at INTEGER
        );

        CREATE TABLE events (
          email        TEXT    NOT NULL,
          id           TEXT    NOT NULL,
          seq          INTEGER NOT NULL,
          clamped_from INTEGER,
          deleted      INTEGER NOT NULL DEFAULT 0,
          updated_at   INTEGER,
          record       TEXT    NOT NULL,
          PRIMARY KEY (email, id)
        ) WITHOUT ROWID;

        CREATE INDEX events_seq   ON events (email, seq);
        CREATE INDEX events_sweep ON events (email, deleted, updated_at);
      `);

      db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('version', '1')",
      ).run();
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply PRAGMAs and run all pending migrations.
 *
 * 1. Sets WAL mode, foreign keys, and busy timeout.
 * 2. Checks if `schema_meta` exists (via sqlite_master).
 * 3. If not, runs the full v1 migration inside a transaction.
 * 4. If it does exist, reads `version` and applies any migrations > current version,
 *    each inside its own transaction.
 *
 * @param {import('node:sqlite').DatabaseSync} db - A DatabaseSync instance from node:sqlite.
 */
export function migrate(db) {
  // PRAGMAs — set outside transactions (WAL must be outside a transaction)
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const currentVersion = getCurrentVersion(db);

  // Apply each pending migration in its own transaction
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      db.exec("BEGIN");
      try {
        migration.up(db);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the current schema version, or 0 if no schema_meta table exists.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
function getCurrentVersion(db) {
  // Check if schema_meta table exists
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
    )
    .get();

  if (!row) {
    return 0;
  }

  // Read the version value
  const versionRow = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get();

  if (!versionRow) {
    return 0;
  }

  return Number(versionRow.value) || 0;
}
