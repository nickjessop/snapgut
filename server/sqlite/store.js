/**
 * SQLite Datastore_Backend implementation.
 *
 * Uses `node:sqlite` (Node 24's built-in DatabaseSync class).
 * All methods are `async` for signature parity with the Memory_Backend,
 * even though the underlying queries are synchronous.
 *
 * @param {import('node:sqlite').DatabaseSync} db - A DatabaseSync instance, already migrated.
 * @returns {object} The Datastore_Backend surface.
 */

const norm = (email) => String(email || "").trim().toLowerCase();

export function createSqliteStore(db) {
  // Prepared statements for performance
  const getUserStmt = db.prepare("SELECT email, created_at FROM users WHERE email = ?");
  const insertUserStmt = db.prepare("INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)");
  const deleteUserStmt = db.prepare("DELETE FROM users WHERE email = ?");

  const sweepRateLimitsStmt = db.prepare("DELETE FROM rate_limits WHERE expires_at < ?");
  const getRateLimitStmt = db.prepare("SELECT count FROM rate_limits WHERE key = ? AND bucket = ?");
  const upsertRateLimitStmt = db.prepare(
    `INSERT INTO rate_limits (key, bucket, count, expires_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1`
  );

  const upsertMissingFoodStmt = db.prepare(
    `INSERT INTO missing_foods (slug, reason, count, last_seen) VALUES (?, ?, 1, ?)
     ON CONFLICT (slug) DO UPDATE SET count = count + 1, last_seen = ?, reason = ?`
  );
  const listMissingFoodsStmt = db.prepare(
    "SELECT slug, reason, count, last_seen FROM missing_foods ORDER BY count DESC LIMIT ?"
  );

  return {
    async getUser(email) {
      const key = norm(email);
      const row = getUserStmt.get(key);
      if (!row) return null;
      return { email: row.email, createdAt: row.created_at };
    },

    async upsertUser(email, now) {
      const key = norm(email);
      const createdAt = now ?? Date.now();
      insertUserStmt.run(key, createdAt);
      // If the user already existed, INSERT OR IGNORE does nothing — read back the row.
      const row = getUserStmt.get(key);
      return { email: row.email, createdAt: row.created_at };
    },

    async deleteUser(email) {
      const key = norm(email);
      deleteUserStmt.run(key);
    },

    async rateLimit(key, max, windowMs, now) {
      const nowMs = now ?? Date.now();
      const bucket = Math.floor(nowMs / windowMs);
      const expiresAt = (bucket + 2) * windowMs;

      // Piggybacked expiry sweep: delete rows whose expires_at is well in the past.
      // Conservative — keeps rows slightly longer than strictly necessary, because
      // expiring a counter early silently raises the limit.
      sweepRateLimitsStmt.run(nowMs - 2 * windowMs);

      // Read-or-create the bucket, increment count
      upsertRateLimitStmt.run(key, bucket, expiresAt);

      // Read back the current count
      const row = getRateLimitStmt.get(key, bucket);
      return row.count <= max;
    },

    async recordMissingFood(slug, reason = "no_image", now) {
      const ts = now ?? Date.now();
      upsertMissingFoodStmt.run(slug, reason, ts, ts, reason);
    },

    async listMissingFoods(limit = 200) {
      const rows = listMissingFoodsStmt.all(limit);
      return rows.map((row) => ({
        slug: row.slug,
        reason: row.reason,
        count: row.count,
        lastSeen: row.last_seen,
      }));
    },
  };
}
