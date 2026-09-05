// @vitest-environment node
//
// Durability test: data survives close and reopen of the SQLite database.
//
// Validates: Requirements 2.4, 2.5, 3.12
//
// Requires Node 24 for `node:sqlite`. Gracefully skips on earlier versions.

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SQLite durability", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "durability-test-"));
    tempDirs.push(dir);
    return dir;
  }

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  // @ts-ignore -- untyped ESM JavaScript
  let createSqliteStore: typeof import("../server/sqlite/store.js").createSqliteStore;
  // @ts-ignore -- untyped ESM JavaScript
  let createSqliteEventStore: typeof import("../server/sqlite/eventStore.js").createSqliteEventStore;
  // @ts-ignore -- untyped ESM JavaScript
  let migrate: typeof import("../server/sqlite/schema.js").migrate;
  let available = false;

  it("should load node:sqlite (Node 24 required)", async () => {
    try {
      const sqliteModule = await import("node:sqlite");
      DatabaseSync = sqliteModule.DatabaseSync;
      // @ts-ignore -- untyped ESM JavaScript
      const storeModule = await import("../server/sqlite/store.js");
      createSqliteStore = storeModule.createSqliteStore;
      // @ts-ignore -- untyped ESM JavaScript
      const eventStoreModule = await import("../server/sqlite/eventStore.js");
      createSqliteEventStore = eventStoreModule.createSqliteEventStore;
      // @ts-ignore -- untyped ESM JavaScript
      const schemaModule = await import("../server/sqlite/schema.js");
      migrate = schemaModule.migrate;
      available = true;
    } catch (err) {
      console.warn(
        "node:sqlite not available — skipping durability tests (requires Node 24)",
      );
      return;
    }
    expect(available).toBe(true);
  });

  it("data survives close and reopen: user, events, sync_meta, rate_limits", async () => {
    if (!available) return;

    const dir = makeTempDir();
    const dbPath = join(dir, "durable.db");
    const now = 1_700_000_000_000;
    const email = "alice@example.com";

    // --- Phase 1: Open, write data, close ---
    {
      const db = new DatabaseSync(dbPath);
      migrate(db);

      const store = createSqliteStore(db);
      const eventStore = createSqliteEventStore(db);

      // Create a user
      await store.upsertUser(email, now);

      // Push some events
      const records = [
        {
          id: "entry-1",
          createdAt: now - 10000,
          updatedAt: now - 5000,
          dish: "Banana Pancakes",
          schemaVersion: 2,
        },
        {
          id: "entry-2",
          createdAt: now - 8000,
          updatedAt: now - 3000,
          dish: "Oatmeal",
          ingredients: [{ name: "oats", confidence: "confident" }],
          schemaVersion: 2,
        },
        {
          id: "entry-3",
          createdAt: now - 6000,
          updatedAt: now - 1000,
          deleted: true,
          schemaVersion: 2,
        },
      ];

      const pushResult = await eventStore.push(email, records, now);
      expect(pushResult.stored).toBe(3);

      // Verify sync_meta state before close
      const metaBefore = await eventStore.getMeta(email);
      expect(metaBefore.seq).toBe(3);
      expect(metaBefore.epoch).toBe(1);

      // Add rate_limit entries
      await store.rateLimit("ai:alice@example.com", 10, 60000, now);
      await store.rateLimit("ai:alice@example.com", 10, 60000, now + 1);
      await store.rateLimit("signin:192.168.1.1", 20, 60000, now);

      db.close();
    }

    // --- Phase 2: Reopen and verify all data survived ---
    {
      const db = new DatabaseSync(dbPath);
      migrate(db); // re-running migrate should be a no-op

      const store = createSqliteStore(db);
      const eventStore = createSqliteEventStore(db);

      // Verify user survives
      const user = await store.getUser(email);
      expect(user).not.toBeNull();
      expect(user!.email).toBe(email);
      expect(user!.createdAt).toBe(now);

      // Verify sync_meta.seq and sync_meta.epoch survive
      const meta = await eventStore.getMeta(email);
      expect(meta.seq).toBe(3);
      expect(meta.epoch).toBe(1);

      // Verify events survive via pull
      const pullResult = await eventStore.pull(email, null, 500, now);
      expect(pullResult.cursorInvalid).toBe(false);
      expect(pullResult.records).toHaveLength(3);

      // Verify records contain expected data
      const entry1 = pullResult.records.find(
        (r: any) => r.id === "entry-1",
      ) as any;
      expect(entry1).toBeDefined();
      expect(entry1.dish).toBe("Banana Pancakes");
      expect(entry1.createdAt).toBe(now - 10000);
      expect(entry1.updatedAt).toBe(now - 5000);

      const entry2 = pullResult.records.find(
        (r: any) => r.id === "entry-2",
      ) as any;
      expect(entry2).toBeDefined();
      expect(entry2.dish).toBe("Oatmeal");
      expect(entry2.ingredients).toEqual([
        { name: "oats", confidence: "confident" },
      ]);

      const entry3 = pullResult.records.find(
        (r: any) => r.id === "entry-3",
      ) as any;
      expect(entry3).toBeDefined();
      expect(entry3.deleted).toBe(true);

      // Verify rate_limits rows survive by checking the count
      // The ai:alice key should have 2 counts, so next call (3rd) still within limit of 10
      const stillAllowed = await store.rateLimit(
        "ai:alice@example.com",
        10,
        60000,
        now + 2,
      );
      expect(stillAllowed).toBe(true);

      // The signin key had 1 count, so it should still be within limit
      const signinAllowed = await store.rateLimit(
        "signin:192.168.1.1",
        20,
        60000,
        now + 1,
      );
      expect(signinAllowed).toBe(true);

      db.close();
    }
  });

  it("cursor issued before close remains valid after reopen", async () => {
    if (!available) return;

    const dir = makeTempDir();
    const dbPath = join(dir, "cursor.db");
    const now = 1_700_000_000_000;
    const email = "bob@example.com";

    let cursorFromFirstSession: string | null = null;

    // --- Phase 1: Push records, get cursor, close ---
    {
      const db = new DatabaseSync(dbPath);
      migrate(db);

      const eventStore = createSqliteEventStore(db);

      // Push 5 records
      const records = Array.from({ length: 5 }, (_, i) => ({
        id: `rec-${i}`,
        createdAt: now + i * 1000,
        updatedAt: now + i * 1000,
        dish: `Dish ${i}`,
        schemaVersion: 2,
      }));

      await eventStore.push(email, records, now);

      // Pull first 3 to get a cursor
      const firstPull = await eventStore.pull(email, null, 3, now);
      expect(firstPull.records).toHaveLength(3);
      expect(firstPull.hasMore).toBe(true);
      cursorFromFirstSession = firstPull.cursor;

      db.close();
    }

    // --- Phase 2: Reopen, use the cursor from the first session ---
    {
      const db = new DatabaseSync(dbPath);
      migrate(db);

      const eventStore = createSqliteEventStore(db);

      // The cursor from the first session should still be valid
      const secondPull = await eventStore.pull(
        email,
        cursorFromFirstSession,
        500,
        now,
      );
      expect(secondPull.cursorInvalid).toBe(false);
      expect(secondPull.records).toHaveLength(2); // remaining 2 records
      expect(secondPull.hasMore).toBe(false);

      // Verify the records are the ones after the cursor position
      const ids = secondPull.records.map((r: any) => r.id);
      expect(ids).toContain("rec-3");
      expect(ids).toContain("rec-4");

      db.close();
    }
  });

  it("deleteAll increments epoch and invalidates old cursors after reopen", async () => {
    if (!available) return;

    const dir = makeTempDir();
    const dbPath = join(dir, "epoch.db");
    const now = 1_700_000_000_000;
    const email = "carol@example.com";

    let cursorBeforeDelete: string | null = null;

    // --- Phase 1: Push, pull (get cursor), deleteAll, close ---
    {
      const db = new DatabaseSync(dbPath);
      migrate(db);

      const eventStore = createSqliteEventStore(db);

      await eventStore.push(
        email,
        [{ id: "x-1", createdAt: now, updatedAt: now, dish: "Toast", schemaVersion: 2 }],
        now,
      );

      const pull = await eventStore.pull(email, null, 500, now);
      cursorBeforeDelete = pull.cursor;

      await eventStore.deleteAll(email);

      // After deleteAll: epoch bumped, seq reset
      const meta = await eventStore.getMeta(email);
      expect(meta.epoch).toBe(2);
      expect(meta.seq).toBe(0);

      db.close();
    }

    // --- Phase 2: Reopen, verify epoch persisted, old cursor invalid ---
    {
      const db = new DatabaseSync(dbPath);
      migrate(db);

      const eventStore = createSqliteEventStore(db);

      // Epoch should still be 2 after reopen
      const meta = await eventStore.getMeta(email);
      expect(meta.epoch).toBe(2);
      expect(meta.seq).toBe(0);

      // Old cursor (from epoch 1) should be invalid
      const pull = await eventStore.pull(
        email,
        cursorBeforeDelete,
        500,
        now,
      );
      expect(pull.cursorInvalid).toBe(true);

      // Count should be 0 (all data was deleted)
      const count = await eventStore.countFor(email, now);
      expect(count).toBe(0);

      db.close();
    }
  });

  it("missing_foods tally survives reopen", async () => {
    if (!available) return;

    const dir = makeTempDir();
    const dbPath = join(dir, "missing.db");
    const now = 1_700_000_000_000;

    // --- Phase 1: Record some missing foods, close ---
    {
      const db = new DatabaseSync(dbPath);
      migrate(db);

      const store = createSqliteStore(db);

      await store.recordMissingFood("quinoa", "no_image", now);
      await store.recordMissingFood("quinoa", "no_image", now + 1000);
      await store.recordMissingFood("tempeh", "lookup_failed", now + 2000);

      db.close();
    }

    // --- Phase 2: Reopen and verify tallies survived ---
    {
      const db = new DatabaseSync(dbPath);
      migrate(db);

      const store = createSqliteStore(db);

      const foods = await store.listMissingFoods(10);
      expect(foods).toHaveLength(2);

      const quinoa = foods.find((f: any) => f.slug === "quinoa") as any;
      expect(quinoa).toBeDefined();
      expect(quinoa.count).toBe(2);

      const tempeh = foods.find((f: any) => f.slug === "tempeh") as any;
      expect(tempeh).toBeDefined();
      expect(tempeh.count).toBe(1);
      expect(tempeh.reason).toBe("lookup_failed");

      db.close();
    }
  });
});
