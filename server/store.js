// Data store for users and rate limits.
// Backends (DATASTORE_BACKEND): "sqlite" (default) | "memory" (dev/tests).
//
// rateLimit() lives in the store so limits/throttles are SHARED across
// instances (in-memory backend is per-process and only suitable for tests).

const BACKEND = process.env.DATASTORE_BACKEND || "sqlite";

const norm = (email) => String(email || "").trim().toLowerCase();

/**
 * The `rateLimits` row a request at `nowMs` belongs to, and the instant that row
 * may be deleted.
 *
 * `rateLimit()` counts per fixed window: a request at instant `t` reads and writes the
 * row keyed `<key>:<floor(t / windowMs)>`. So the row for bucket `b` is consulted
 * only by requests in `[b * windowMs, (b + 1) * windowMs)` and stops being able to affect a
 * limit decision at exactly `(b + 1) * windowMs`, when the key changes and a fresh row
 * takes over.
 *
 * The expiry here is `(b + 2) * windowMs` — one whole window past the earliest instant that
 * would be correct. The margin is deliberate: expiring a counter early silently
 * raises the limit (an attacker's requests stop being counted), whereas expiring it late
 * costs one small row for one extra window. Both errors are not equally bad, so the
 * bound is set on the safe side.
 *
 * Derived from the bucket rather than from `nowMs`, so every write within a window computes
 * the identical value and the merge never moves the expiry.
 */
export function rateLimitWindow(nowMs, windowMs) {
  const bucket = Math.floor(nowMs / windowMs);
  return { bucket, expireAtMs: (bucket + 2) * windowMs };
}

function newUser(email, now) {
  return {
    email: norm(email),
    createdAt: now ?? Date.now(),
  };
}

// ---- in-memory (dev) ----
function memoryStore() {
  const users = new Map();
  const rl = new Map(); // key -> timestamps[]
  const missing = new Map(); // food slug -> { slug, count, lastSeen }
  return {
    async recordMissingFood(slug, reason = "no_image", now) {
      const rec = missing.get(slug) || { slug, count: 0, lastSeen: 0, reason };
      rec.count += 1;
      rec.lastSeen = now ?? Date.now();
      rec.reason = reason;
      missing.set(slug, rec);
    },
    async listMissingFoods(limit = 200) {
      return [...missing.values()].sort((a, b) => b.count - a.count).slice(0, limit);
    },
    async getUser(email) {
      return users.get(norm(email)) || null;
    },
    async upsertUser(email, now) {
      const key = norm(email);
      let u = users.get(key);
      if (!u) {
        u = newUser(key, now);
        users.set(key, u);
      }
      return u;
    },
    async deleteUser(email) {
      const key = norm(email);
      users.delete(key);
    },
    async rateLimit(key, max, windowMs) {
      const now = Date.now();
      const arr = (rl.get(key) || []).filter((t) => now - t < windowMs);
      arr.push(now);
      rl.set(key, arr);
      return arr.length <= max;
    },
  };
}

let storePromise = null;
export function getStore() {
  if (!storePromise) {
    if (BACKEND === "memory") {
      storePromise = Promise.resolve(memoryStore());
    } else if (BACKEND === "sqlite") {
      storePromise = (async () => {
        const { DatabaseSync } = await import("node:sqlite");
        const { migrate } = await import("./sqlite/schema.js");
        const { createSqliteStore } = await import("./sqlite/store.js");
        const { openDatabase } = await import("./sqlite/open.js");
        const { db } = openDatabase(DatabaseSync);
        migrate(db);
        return createSqliteStore(db);
      })();
    } else {
      console.error(
        `Fatal: unrecognised DATASTORE_BACKEND="${BACKEND}". Accepted values: "sqlite", "memory".`
      );
      process.exit(1);
    }
  }
  return storePromise;
}

export { norm, BACKEND };
