/**
 * SQLite Event_Store_Backend implementation.
 *
 * Uses `node:sqlite` (Node 24's built-in DatabaseSync class).
 * All methods are `async` for signature parity with the Memory_Backend,
 * even though the underlying queries are synchronous.
 *
 * Key design points:
 * - Uses `BEGIN IMMEDIATE` for push transactions (first statement is a read,
 *   need write lock upfront to avoid upgrade failures).
 * - Uses the shared `planPush` planner from `server/eventStore.js`.
 * - The `record` column holds the full wire record as JSON.
 * - `deleted` and `updated_at` are denormalized copies for indexing the
 *   tombstone sweep — never read as truth.
 * - Tombstone sweep runs on pull and countFor using the `events_sweep` index.
 *
 * @param {import('node:sqlite').DatabaseSync} db - A DatabaseSync instance, already migrated.
 * @returns {object} The Event_Store_Backend surface.
 */

import { norm } from "../store.js";
import {
  planPush,
  storableId,
  isTombstone,
  parseCursor,
  formatCursor,
  pageLimit,
  TOMBSTONE_RETENTION_MS,
  INITIAL_SEQ,
  INITIAL_EPOCH,
} from "../eventStore.js";

export function createSqliteEventStore(db) {
  // --- Prepared statements ---

  // User management (ensureUser for push)
  const ensureUserStmt = db.prepare(
    "INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)"
  );

  // sync_meta reads and writes
  const readMetaStmt = db.prepare(
    "SELECT seq, epoch, last_tombstone_sweep_at FROM sync_meta WHERE email = ?"
  );
  const upsertMetaStmt = db.prepare(
    `INSERT INTO sync_meta (email, seq, epoch, last_tombstone_sweep_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET seq = excluded.seq, epoch = excluded.epoch, last_tombstone_sweep_at = excluded.last_tombstone_sweep_at`
  );
  const setSeqStmt = db.prepare("UPDATE sync_meta SET seq = ? WHERE email = ?");
  const bumpEpochStmt = db.prepare(
    "UPDATE sync_meta SET seq = 0, epoch = epoch + 1 WHERE email = ?"
  );

  // Events reads and writes
  const upsertEventStmt = db.prepare(
    `INSERT INTO events (email, id, seq, clamped_from, deleted, updated_at, record)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (email, id) DO UPDATE SET
       seq = excluded.seq,
       clamped_from = excluded.clamped_from,
       deleted = excluded.deleted,
       updated_at = excluded.updated_at,
       record = excluded.record`
  );

  // Pull query: one extra row for hasMore detection
  const pullEventsStmt = db.prepare(
    "SELECT seq, clamped_from, record FROM events WHERE email = ? AND seq > ? ORDER BY seq LIMIT ?"
  );

  // Delete all events for a user
  const deleteEventsStmt = db.prepare("DELETE FROM events WHERE email = ?");
  const countEventsStmt = db.prepare(
    "SELECT COUNT(*) AS cnt FROM events WHERE email = ?"
  );

  // Tombstone sweep: delete expired tombstones using the events_sweep index
  const sweepTombstonesStmt = db.prepare(
    "DELETE FROM events WHERE email = ? AND deleted = 1 AND updated_at IS NOT NULL AND updated_at < ?"
  );

  // Update last_tombstone_sweep_at in sync_meta
  const updateSweepAtStmt = db.prepare(
    "UPDATE sync_meta SET last_tombstone_sweep_at = ? WHERE email = ?"
  );

  // --- Helpers ---

  function readMeta(email) {
    const row = readMetaStmt.get(email);
    if (!row) {
      return { seq: INITIAL_SEQ, epoch: INITIAL_EPOCH, lastTombstoneSweepAt: null };
    }
    return {
      seq: Number.isInteger(row.seq) && row.seq > 0 ? row.seq : INITIAL_SEQ,
      epoch: Number.isInteger(row.epoch) && row.epoch > 0 ? row.epoch : INITIAL_EPOCH,
      lastTombstoneSweepAt: Number.isInteger(row.last_tombstone_sweep_at)
        ? row.last_tombstone_sweep_at
        : null,
    };
  }

  function ensureUser(email, now) {
    ensureUserStmt.run(email, now);
  }

  function ensureMeta(email, now = Date.now()) {
    // Ensure both user and sync_meta rows exist (FK constraint requires user first)
    ensureUser(email, now);
    const existing = readMetaStmt.get(email);
    if (!existing) {
      upsertMetaStmt.run(email, INITIAL_SEQ, INITIAL_EPOCH, null);
    }
  }

  /**
   * Load existing entries for the given ids. Returns a Map of id → { record, clampedFrom }.
   */
  function loadEntries(email, ids) {
    if (ids.length === 0) return new Map();
    // Build a parameterized IN query dynamically based on ids count
    const placeholders = ids.map(() => "?").join(",");
    const stmt = db.prepare(
      `SELECT id, seq, clamped_from, record FROM events WHERE email = ? AND id IN (${placeholders})`
    );
    const rows = stmt.all(email, ...ids);
    const entries = new Map();
    for (const row of rows) {
      const record = JSON.parse(row.record);
      entries.set(row.id, {
        record,
        seq: row.seq,
        clampedFrom: Number.isInteger(row.clamped_from) ? row.clamped_from : null,
      });
    }
    return entries;
  }

  function upsertEvent(email, id, written, seq) {
    const record = written.record;
    const deleted = isTombstone(record) ? 1 : 0;
    const updatedAt = Number.isInteger(record.updatedAt) ? record.updatedAt : null;
    const clampedFrom = written.clampedFrom;
    const recordJson = JSON.stringify(record);
    upsertEventStmt.run(email, id, seq, clampedFrom ?? null, deleted, updatedAt, recordJson);
  }

  /**
   * Sweep expired tombstones for the given user. Updates last_tombstone_sweep_at.
   */
  function sweepTombstones(email, now) {
    const cutoff = now - TOMBSTONE_RETENTION_MS;
    sweepTombstonesStmt.run(email, cutoff);
    updateSweepAtStmt.run(now, email);
  }

  // --- Public interface ---

  return {
    async push(email, records, now = Date.now()) {
      const key = norm(email);
      const list = Array.isArray(records) ? records : [];

      // Validate all record ids upfront
      for (const r of list) {
        if (!storableId(r?.id)) throw new Error("event store: unusable event id");
      }

      if (list.length === 0) return { outcomes: [], stored: 0, highestSequence: null };

      // Collect distinct ids in first-sent order
      const ids = [];
      const seen = new Set();
      for (const r of list) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          ids.push(r.id);
        }
      }

      db.exec("BEGIN IMMEDIATE");
      try {
        ensureMeta(key, now);

        const meta = readMeta(key);
        const entries = loadEntries(key, ids);
        const { outcomes, writes } = planPush(
          list,
          (id) => entries.get(id) ?? null,
          now
        );

        let seq = meta.seq;
        for (const [id, written] of writes) {
          upsertEvent(key, id, written, ++seq);
        }
        if (writes.size > 0) {
          setSeqStmt.run(seq, key);
        }

        db.exec("COMMIT");
        return {
          outcomes,
          stored: writes.size,
          highestSequence: writes.size > 0 ? seq : null,
        };
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    async pull(email, cursor = null, limit = 500, now = Date.now()) {
      const key = norm(email);

      // Ensure meta exists for reading
      ensureMeta(key, now);
      const meta = readMeta(key);

      // Parse cursor and check epoch validity
      let sinceSeq = 0;
      if (cursor !== null && cursor !== undefined && cursor !== "") {
        const parsed = parseCursor(cursor);
        if (parsed === null || parsed.epoch !== meta.epoch) {
          return { cursorInvalid: true, records: [], cursor: null, hasMore: false };
        }
        sinceSeq = parsed.sequence;
      }

      // Sweep expired tombstones
      sweepTombstones(key, now);

      // Query one extra row to detect hasMore
      const size = pageLimit(limit);
      const rows = pullEventsStmt.all(key, sinceSeq, size + 1);

      const page = rows.slice(0, size);
      const hasMore = rows.length > size;
      const lastSeq = page.length > 0 ? page[page.length - 1].seq : sinceSeq;

      // Return records without seq and clampedFrom (server bookkeeping)
      const resultRecords = page.map((row) => {
        const record = JSON.parse(row.record);
        return { ...record };
      });

      return {
        cursorInvalid: false,
        records: resultRecords,
        cursor: formatCursor(meta.epoch, lastSeq),
        hasMore,
      };
    },

    async deleteAll(email) {
      const key = norm(email);

      // Count events before deletion
      const countRow = countEventsStmt.get(key);
      const deleted = countRow ? countRow.cnt : 0;

      // Delete all events
      deleteEventsStmt.run(key);

      // Bump epoch and reset seq — ensure meta row exists first
      ensureMeta(key, Date.now());
      bumpEpochStmt.run(key);

      // Read back the new epoch
      const meta = readMeta(key);

      return { deleted, epoch: meta.epoch };
    },

    async countFor(email, now = Date.now()) {
      const key = norm(email);

      // Ensure meta exists for sweep tracking
      ensureMeta(key, now);

      // Sweep expired tombstones first
      sweepTombstones(key, now);

      // Count all remaining events (matches memory backend: state.records.size after sweep)
      const row = countEventsStmt.get(key);
      return row ? row.cnt : 0;
    },

    async getMeta(email) {
      const key = norm(email);
      const meta = readMeta(key);
      return {
        seq: meta.seq,
        epoch: meta.epoch,
        lastTombstoneSweepAt: meta.lastTombstoneSweepAt,
      };
    },
  };
}
