// @vitest-environment node
//
// Schema migration tests for the SQLite backend.
//
// Validates: Requirements 2.4, 2.5
//
// Requires Node 24 for `node:sqlite`. Gracefully skips on earlier versions.

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SQLite schema migration", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tempDirs = [];
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "schema-test-"));
    tempDirs.push(dir);
    return dir;
  }

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  // @ts-ignore -- untyped ESM JavaScript
  let migrate: typeof import("../server/sqlite/schema.js").migrate;
  let available = false;

  it("should load node:sqlite (Node 24 required)", async () => {
    try {
      const sqliteModule = await import("node:sqlite");
      DatabaseSync = sqliteModule.DatabaseSync;
      // @ts-ignore -- untyped ESM JavaScript
      const schemaModule = await import("../server/sqlite/schema.js");
      migrate = schemaModule.migrate;
      available = true;
    } catch (err) {
      console.warn(
        "node:sqlite not available — skipping schema tests (requires Node 24)",
      );
      return;
    }
    expect(available).toBe(true);
  });

  it("migration from empty creates all tables and indexes", async () => {
    if (!available) return;

    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const db = new DatabaseSync(dbPath);

    migrate(db);

    // Verify all expected tables exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row: any) => row.name);

    expect(tables).toContain("schema_meta");
    expect(tables).toContain("users");
    expect(tables).toContain("rate_limits");
    expect(tables).toContain("missing_foods");
    expect(tables).toContain("sync_meta");
    expect(tables).toContain("events");

    // Verify schema_meta contains the version
    const version = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as any;
    expect(version).not.toBeNull();
    expect(version.value).toBe("1");

    // Verify all expected indexes exist
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row: any) => row.name);

    expect(indexes).toContain("rate_limits_expires");
    expect(indexes).toContain("events_seq");
    expect(indexes).toContain("events_sweep");

    // Verify the users table has the expected columns
    const usersInfo = db.prepare("PRAGMA table_info(users)").all() as any[];
    const userCols = usersInfo.map((col) => col.name);
    expect(userCols).toContain("email");
    expect(userCols).toContain("created_at");

    // Verify the events table has the expected columns
    const eventsInfo = db.prepare("PRAGMA table_info(events)").all() as any[];
    const eventCols = eventsInfo.map((col) => col.name);
    expect(eventCols).toContain("email");
    expect(eventCols).toContain("id");
    expect(eventCols).toContain("seq");
    expect(eventCols).toContain("clamped_from");
    expect(eventCols).toContain("deleted");
    expect(eventCols).toContain("updated_at");
    expect(eventCols).toContain("record");

    // Verify the sync_meta table has the expected columns
    const syncInfo = db.prepare("PRAGMA table_info(sync_meta)").all() as any[];
    const syncCols = syncInfo.map((col) => col.name);
    expect(syncCols).toContain("email");
    expect(syncCols).toContain("seq");
    expect(syncCols).toContain("epoch");
    expect(syncCols).toContain("last_tombstone_sweep_at");

    // Verify the rate_limits table has the expected columns
    const rlInfo = db.prepare("PRAGMA table_info(rate_limits)").all() as any[];
    const rlCols = rlInfo.map((col) => col.name);
    expect(rlCols).toContain("key");
    expect(rlCols).toContain("bucket");
    expect(rlCols).toContain("count");
    expect(rlCols).toContain("expires_at");

    // Verify the missing_foods table has the expected columns
    const mfInfo = db
      .prepare("PRAGMA table_info(missing_foods)")
      .all() as any[];
    const mfCols = mfInfo.map((col) => col.name);
    expect(mfCols).toContain("slug");
    expect(mfCols).toContain("reason");
    expect(mfCols).toContain("count");
    expect(mfCols).toContain("last_seen");

    db.close();
  });

  it("re-running migrate on an already-initialized database is a no-op", async () => {
    if (!available) return;

    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const db = new DatabaseSync(dbPath);

    // First migration
    migrate(db);

    // Capture the schema state
    const schemaBeforeRows = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master ORDER BY type, name",
      )
      .all();
    const schemaBefore = JSON.stringify(schemaBeforeRows);

    // Insert a record to verify data is preserved after re-migration
    db.exec(
      "INSERT INTO users (email, created_at) VALUES ('test@example.com', 1700000000000)",
    );

    // Second migration — should not throw and should not alter the schema
    expect(() => migrate(db)).not.toThrow();

    // Verify schema is unchanged
    const schemaAfterRows = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master ORDER BY type, name",
      )
      .all();
    const schemaAfter = JSON.stringify(schemaAfterRows);
    expect(schemaAfter).toEqual(schemaBefore);

    // Verify existing data is preserved
    const user = db
      .prepare("SELECT email, created_at FROM users WHERE email = ?")
      .get("test@example.com") as any;
    expect(user).not.toBeNull();
    expect(user.email).toBe("test@example.com");
    expect(user.created_at).toBe(1700000000000);

    // Third migration — also a no-op
    expect(() => migrate(db)).not.toThrow();

    db.close();
  });

  it("migration works on an in-memory database", async () => {
    if (!available) return;

    const db = new DatabaseSync(":memory:");

    expect(() => migrate(db)).not.toThrow();

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row: any) => row.name);

    expect(tables).toContain("schema_meta");
    expect(tables).toContain("users");
    expect(tables).toContain("rate_limits");
    expect(tables).toContain("missing_foods");
    expect(tables).toContain("sync_meta");
    expect(tables).toContain("events");

    db.close();
  });

  it("schema_meta version is set correctly after migration", async () => {
    if (!available) return;

    const db = new DatabaseSync(":memory:");
    migrate(db);

    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as any;
    expect(row).not.toBeNull();
    expect(row.value).toBe("1");

    db.close();
  });
});
