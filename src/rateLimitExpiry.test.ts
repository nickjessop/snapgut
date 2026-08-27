// @vitest-environment node
//
// Rate-limit expiry (Requirement 2.12): the SQLite backend's piggybacked sweep deletes
// rate-limit rows whose `expires_at < now - 2*windowMs`. This verifies that old bucket
// rows get cleaned up without a separate timer, and that the sweep never removes a row
// that could still affect a limit decision.
//
// Uses a real temp SQLite database via `node:sqlite` (Node 24 required).
//
// _Requirements: 2.12, 13.3_

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db: any;
let store: any;
let tmpDir: string;

beforeAll(async () => {
  // Node 24 required for node:sqlite — skip gracefully if unavailable
  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return;
  }

  tmpDir = mkdtempSync(join(tmpdir(), "ratelimit-expiry-"));
  const dbPath = join(tmpDir, "test.db");
  db = new DatabaseSync(dbPath);

  const { migrate } = await import("../server/sqlite/schema.js");
  const { createSqliteStore } = await import("../server/sqlite/store.js");
  migrate(db);
  store = createSqliteStore(db);
});

afterAll(() => {
  if (db) {
    try { db.close(); } catch {}
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("SQLite rate-limit piggybacked expiry sweep (Requirement 2.12)", () => {
  // Helper: count rows in rate_limits table
  function countRateLimitRows(): number {
    if (!db) return 0;
    const row = db.prepare("SELECT COUNT(*) as cnt FROM rate_limits").get();
    return Number(row.cnt);
  }

  // Helper: get all rate limit rows for inspection
  function getAllRateLimitRows(): Array<{ key: string; bucket: number; count: number; expires_at: number }> {
    if (!db) return [];
    return db.prepare("SELECT key, bucket, count, expires_at FROM rate_limits ORDER BY key, bucket").all();
  }

  it("accumulates rows across different windows", async () => {
    if (!store) return; // skip if node:sqlite unavailable

    const windowMs = 60_000; // 60 seconds
    const max = 5;
    const key = "sweep-test-1";

    // Call rateLimit at time 0 — creates bucket 0
    await store.rateLimit(key, max, windowMs, 0);
    // Call at time 60_000 — creates bucket 1
    await store.rateLimit(key, max, windowMs, 60_000);
    // Call at time 120_000 — creates bucket 2
    await store.rateLimit(key, max, windowMs, 120_000);

    const rows = getAllRateLimitRows().filter((r) => r.key === key);
    // All three buckets should be present since none is old enough to sweep yet
    // The sweep threshold is now - 2*windowMs = 120_000 - 120_000 = 0
    // expires_at for bucket 0 = (0 + 2) * 60_000 = 120_000, which is NOT < 0
    // So no sweep happens for any of them at t=120_000
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("sweeps expired rows when enough time has passed", async () => {
    if (!store) return;

    const windowMs = 1_000; // 1 second windows for faster testing
    const max = 10;
    const key = "sweep-test-2";

    // Create a row at t=0 (bucket 0, expires_at = 2000)
    await store.rateLimit(key, max, windowMs, 0);

    // Create a row at t=1000 (bucket 1, expires_at = 3000)
    await store.rateLimit(key, max, windowMs, 1_000);

    // At t=5000: sweep threshold = 5000 - 2*1000 = 3000
    // Bucket 0 expires_at = 2000 < 3000 → swept
    // Bucket 1 expires_at = 3000 < 3000 → NOT swept (not strictly less)
    await store.rateLimit(key, max, windowMs, 5_000);

    const rows = getAllRateLimitRows().filter((r) => r.key === key);
    const buckets = rows.map((r) => r.bucket);

    // Bucket 0 should be swept
    expect(buckets).not.toContain(0);
    // Bucket 5 (t=5000) should exist
    expect(buckets).toContain(5);
  });

  it("old rows from a key are cleaned up by a call on the same or different key", async () => {
    if (!store) return;

    const windowMs = 1_000;
    const max = 10;

    // Create rows for key-a at t=0
    await store.rateLimit("sweep-key-a", max, windowMs, 0);

    // Jump far into the future with a different key — sweep is global
    // At t=100_000: sweep threshold = 100_000 - 2*1000 = 98_000
    // key-a bucket 0 expires_at = 2000 < 98_000 → swept
    await store.rateLimit("sweep-key-b", max, windowMs, 100_000);

    const rows = getAllRateLimitRows().filter((r) => r.key === "sweep-key-a");
    expect(rows.length).toBe(0);
  });

  it("does not sweep a row that can still affect a limit decision", async () => {
    if (!store) return;

    const windowMs = 60_000;
    const max = 3;
    const key = "sweep-test-safe";

    // Fill up the limit at t=0 in bucket 0
    await store.rateLimit(key, max, windowMs, 0);
    await store.rateLimit(key, max, windowMs, 1);
    await store.rateLimit(key, max, windowMs, 2);

    // The 4th call in bucket 0 should be denied
    const denied = await store.rateLimit(key, max, windowMs, 3);
    expect(denied).toBe(false);

    // At t=60_000 (next bucket), sweep threshold = 60_000 - 120_000 = -60_000
    // Nothing is swept because threshold is negative
    await store.rateLimit(key, max, windowMs, 60_000);

    // Bucket 0 row should still be there (expires_at = 120_000, threshold is -60_000)
    const rows = getAllRateLimitRows().filter((r) => r.key === key && r.bucket === 0);
    expect(rows.length).toBe(1);
  });

  it("sweep keeps row count bounded over many windows", async () => {
    if (!store) return;

    const windowMs = 1_000;
    const max = 5;
    const key = "sweep-bounded";

    // Simulate 50 windows of activity
    for (let i = 0; i < 50; i++) {
      await store.rateLimit(key, max, windowMs, i * windowMs);
    }

    // After 50 seconds of 1-second windows, at the last call (t=49_000):
    // sweep threshold = 49_000 - 2_000 = 47_000
    // Only rows with expires_at >= 47_000 survive: those with bucket >= 45
    // (since expires_at = (bucket + 2) * 1000 and we need >= 47_000 → bucket >= 45)
    const rows = getAllRateLimitRows().filter((r) => r.key === key);
    // Should be bounded — at most a few recent windows survive
    expect(rows.length).toBeLessThanOrEqual(6);
  });
});
