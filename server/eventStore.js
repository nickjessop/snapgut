// Per-user event store for Cloud sync (the Sync_Service's storage layer).
// Backends (DATASTORE_BACKEND): "sqlite" (default) | "memory" (dev/tests).
//
// This module owns everything that touches stored Event_Records: the merge rule,
// Server_Sequence allocation, the cursor codec, the purge generation, and
// tombstone retention. `server/sync.js` owns the HTTP shell — auth, entitlement,
// rate limits, and every size/shape validation — so by the time a record reaches
// `push()` it is already validated and rejection has already happened without
// storing anything (Req 6.10).
//
// The merge rule below is a deliberate transcription of `mergeRecords` /
// `compareForMerge` / `canonicalKey` in `src/cloudSync.ts` (Req 8.1–8.7). The two
// copies are separate code — the server is plain ESM JS, the client TypeScript —
// so their agreement is asserted by property tests over generated pairs rather
// than by a shared import. Keep them in lockstep: any change here needs the same
// change there.

import { norm } from "./store.js";

const BACKEND = process.env.DATASTORE_BACKEND || "sqlite";

/** A pulled page holds at most this many Event_Records (Req 7.2). */
export const MAX_PULL_LIMIT = 500;

/**
 * An `updatedAt` more than this far beyond the server clock is stored as the
 * server clock value instead (Req 8.8) — one day of tolerated clock skew.
 */
export const MAX_CLOCK_SKEW_MS = 86_400_000;

/** Tombstones are retained at least this long after their Revision_Time (Req 9.7). */
export const TOMBSTONE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** Sequence and epoch a user starts from before anything is stored. */
export const INITIAL_SEQ = 0;
export const INITIAL_EPOCH = 1;

// ---------------------------------------------------------------------------
// Stored shape
//
// A stored record is a wire Event_Record — the same shape the client pushes and
// pulls, with any unrecognized field from a newer schemaVersion kept verbatim
// (Req 16.4). Server_Sequence is held *beside* the record rather than inside it,
// for two reasons: the merge rule must never consider Server_Sequence (Req 8.3),
// and a pull must not hand `seq` back to the client, where it would be preserved
// as an unknown field and smuggled onto the next push.
// ---------------------------------------------------------------------------

/**
 * Bookkeeping a backend holds *beside* the record, never inside it.
 *
 * `seq` is the Server_Sequence and `clampedFrom` is the Revision_Time the clock
 * clamp consumed (see `republishedClamp`). Both are server-side state, and the
 * Firestore backend keeps them as fields of the same document as the record —
 * so a pushed field of either name is dropped rather than preserved as an
 * unknown field. Letting one through would put server state on the wire, where
 * the client would preserve it and push it back, and would leave the memory
 * backend holding a shape the Firestore document could not reproduce.
 */
const STORE_ONLY_KEYS = new Set(["seq", "clampedFrom"]);

/** Content fields a Tombstone never carries (Req 9.1, 9.2, 20.8). */
const CONTENT_KEYS = new Set([
  "note",
  "dish",
  "ingredients",
  "symptoms",
  "bristol",
  "stress",
  "sleep",
]);

/** `deleted === true` is the only tombstone marker, on both sides (Req 9.1). */
export function isTombstone(record) {
  return record?.deleted === true;
}

/**
 * Replace an `updatedAt` more than MAX_CLOCK_SKEW_MS beyond the server clock
 * with the server clock value (Req 8.8). The replaced value is what gets stored,
 * so every later merge for that `id` and every pull response that carries the
 * record see the clamped value and not the original.
 *
 * A non-integer `updatedAt` is left alone: it cannot be compared as epoch
 * milliseconds, so the ordering reads it as 0 and falls through to the later
 * keys, exactly as the client does.
 */
export function clampUpdatedAt(updatedAt, now) {
  if (!Number.isInteger(updatedAt)) return updatedAt;
  return updatedAt > now + MAX_CLOCK_SKEW_MS ? now : updatedAt;
}

/** True when `clampUpdatedAt` would replace this value — see `planPush`. */
function wasClamped(updatedAt, now) {
  return Number.isInteger(updatedAt) && updatedAt > now + MAX_CLOCK_SKEW_MS;
}

/**
 * The record as it will be stored: clock-clamped, photo-free, and — for a
 * Tombstone — stripped of note text and every type-specific field (Req 9.2).
 *
 * A `seq` or `clampedFrom` carried by the payload is dropped rather than
 * preserved as an unknown field — see `STORE_ONLY_KEYS`.
 *
 * `deleted` is normalized to "present and `true`, or absent", so a stored record
 * carries the same key set as the client's own record for the same event. That
 * matters because `canonicalKey` reads the key set: a stray `deleted: false`
 * would order differently on the two sides and break the merge parity the
 * requirements demand of client and server (Req 8.3).
 */
export function normalizeForStore(record, now = Date.now()) {
  const tombstone = isTombstone(record);
  const out = {};

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (key === "photo") continue; // Photo bytes are never stored (Req 16.1)
    if (STORE_ONLY_KEYS.has(key)) continue; // server-side state, never the client's
    if (key === "deleted") continue; // re-added below, only when true
    if (tombstone && CONTENT_KEYS.has(key)) continue; // Req 9.2
    out[key] = key === "updatedAt" ? clampUpdatedAt(value, now) : value;
  }

  if (tombstone) out.deleted = true;

  return out;
}

// ---------------------------------------------------------------------------
// Storable ids (Req 6.3, 18.1)
//
// An Event_Record is keyed by the pair of user identity and `id`, and on the
// Firestore backend both halves of that pair become one path segment. Firestore
// cannot address every string as a segment, so the set below is the same on every
// backend: what one backend can key, all of them can, and a developer running the
// memory backend cannot build an id production would refuse.
//
// `server/sync.js` applies this at the edge, where an unstorable `id` earns a
// per-id `invalid_record` rejection.
// ---------------------------------------------------------------------------

/** Firestore's document id byte ceiling — the tightest limit of any backend. */
const MAX_ID_BYTES = 1_500;

const idEncoder = new TextEncoder();

/**
 * Whether this value can key a stored Event_Record.
 *
 * Rejected: anything that is not a non-empty string, an id containing `/` (which
 * would address another document rather than fail), the relative segments `.` and
 * `..`, the `__reserved__` pattern Firestore keeps for itself, and anything over
 * the byte ceiling.
 */
export function storableId(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("/") || value === "." || value === "..") return false;
  if (/^__.*__$/.test(value)) return false;
  return idEncoder.encode(value).length <= MAX_ID_BYTES;
}

// ---------------------------------------------------------------------------
// Merge rule (Req 8) — mirror of `src/cloudSync.ts`
//
//   1. greater `updatedAt`, compared as integer epoch milliseconds (Req 8.1)
//   2. on a tie, the Tombstone (Req 8.2)
//   3. then greater `createdAt` (Req 8.3)
//   4. then the record ordered last by `canonicalKey` (Req 8.3)
//
// Never a factor: which side holds a record, arrival order, Server_Sequence, or
// Photos (Req 8.3, 8.7). Four total orders over field values composed
// lexicographically, so the rule is total, deterministic, idempotent,
// commutative, and associative (Req 8.5, 8.6).
// ---------------------------------------------------------------------------

/**
 * Keys left out of `canonicalKey`, matching the client's exclusion list:
 * `photo` (never a merge factor, Req 8.7), `schemaVersion` (wire envelope, not
 * event data), and `unknownFields` (the client's *container* — its contents
 * travel inline, which is how a stored record already holds them).
 */
const CANONICAL_EXCLUDED_KEYS = new Set(["photo", "schemaVersion", "unknownFields"]);

/** Defensive nesting ceiling so a pathological value can never hang a merge. */
const MAX_CANONICAL_DEPTH = 16;

/**
 * JSON with object keys sorted, so the string depends on field *values* only and
 * never on insertion order. Arrays keep their order — element order is data.
 * Anything JSON cannot express collapses rather than throwing, which keeps the
 * ordering total over every input (Req 8.5).
 */
function canonicalStringify(value, depth = 0) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (depth >= MAX_CANONICAL_DEPTH) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item, depth + 1)).join(",")}]`;
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalStringify(value[key], depth + 1)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * The single total ordering of Event_Record field values that Requirement 8.3
 * uses to break an `updatedAt` + tombstone + `createdAt` tie: stable, key-sorted
 * JSON of every field except the excluded ones.
 *
 * A stored record already carries its unknown fields at the top level, so unlike
 * the client there is no container to fold in — the key set the client produces
 * for the same event and the key set produced here are the same.
 */
export function canonicalKey(record) {
  const fields = {};
  for (const [key, value] of Object.entries(record)) {
    if (CANONICAL_EXCLUDED_KEYS.has(key)) continue;
    if (value === undefined) continue;
    fields[key] = value;
  }
  return canonicalStringify(fields);
}

/**
 * Requirement 8.1 compares Revision_Times "as integer epoch milliseconds". A
 * value that is not an integer cannot take part in that comparison, so it reads
 * as 0 here and the ordering falls through to the later keys — which still see
 * the real value through `canonicalKey`.
 */
function asOrderedInt(value) {
  return Number.isInteger(value) ? value : 0;
}

/**
 * `-1` when `a` loses, `1` when `a` wins, `0` when the two records agree on every
 * field the ordering can see.
 */
export function compareForMerge(a, b) {
  const au = asOrderedInt(a.updatedAt);
  const bu = asOrderedInt(b.updatedAt);
  if (au !== bu) return au > bu ? 1 : -1; // Req 8.1

  const aDeleted = isTombstone(a);
  const bDeleted = isTombstone(b);
  if (aDeleted !== bDeleted) return aDeleted ? 1 : -1; // Req 8.2

  const ac = asOrderedInt(a.createdAt);
  const bc = asOrderedInt(b.createdAt);
  if (ac !== bc) return ac > bc ? 1 : -1; // Req 8.3

  const ak = canonicalKey(a);
  const bk = canonicalKey(b);
  if (ak === bk) return 0;
  return ak > bk ? 1 : -1; // Req 8.3 — the record ordered last is retained
}

/**
 * Merge the two sides holding an `id`, returning the record to retain.
 *
 * `null` means "no entry on this side" — not a record with a zero Revision_Time
 * and not a deletion; the present record is returned unchanged, including when it
 * is a Tombstone (Req 8.4).
 *
 * The winner is returned by reference. On a `0` comparison `a` is returned, which
 * makes `mergeRecords(x, x) === x` and lets `push` recognize "the stored record
 * won, nothing changed" by identity — the basis of push idempotence (Req 6.5).
 */
export function mergeRecords(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return compareForMerge(a, b) >= 0 ? a : b;
}

// ---------------------------------------------------------------------------
// Sync_Cursor codec — `"{epoch}:{seq}"`
//
// Opaque to the client, structured here: `epoch` is the purge generation held
// beside `seq`. `deleteAll()` — the one thing that empties a user's stored
// Event_Records (Req 17.1, 17.4) — increments `epoch` and resets `seq` to 0, which
// is what lets a pull recognize a stale cursor and answer `cursor_invalid` instead
// of silently matching nothing (Req 13.13, 17.5).
//
// Mirrors `formatCursor` / `parseCursor` in `src/cloudSync.ts`.
// ---------------------------------------------------------------------------

const CURSOR_PATTERN = /^(\d+):(\d+)$/;

function cursorComponent(value) {
  if (!Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  if (truncated <= 0) return 0;
  return Math.min(truncated, Number.MAX_SAFE_INTEGER);
}

/** Build the cursor token for a purge generation and a Server_Sequence. */
export function formatCursor(epoch, sequence) {
  return `${cursorComponent(epoch)}:${cursorComponent(sequence)}`;
}

/** Read a cursor token, or `null` when there is nothing usable to read. */
export function parseCursor(token) {
  if (typeof token !== "string") return null;
  const match = CURSOR_PATTERN.exec(token);
  if (match === null) return null;
  const epoch = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(sequence)) return null;
  return { epoch, sequence };
}

/** Clamp a caller-supplied page size into 1…500 (Req 7.2). */
export function pageLimit(limit) {
  if (!Number.isFinite(limit)) return MAX_PULL_LIMIT;
  const truncated = Math.trunc(limit);
  if (truncated < 1) return 1;
  return Math.min(truncated, MAX_PULL_LIMIT);
}

// ---------------------------------------------------------------------------
// Push planning, shared by every backend
//
// Given the records currently stored for the ids in a payload, decide what the
// store should end up holding. Pure: no clock reads beyond the `now` passed in,
// no I/O. The backends differ only in how they read the "before" state and how
// they commit the plan.
//
// Every id in the payload is acknowledged as stored (Req 6.11) — including an id
// whose pushed record *loses* the merge, which is what Requirements 9.5 and 9.8
// ask for: a re-creation with a greater Revision_Time replaces the Tombstone, and
// one with an equal or lesser Revision_Time leaves the Tombstone in place, but
// both are acknowledged so the client can clear its Outbox either way.
//
// Only a changed record is written, and only a written record takes a new
// Server_Sequence. Re-pushing an unchanged payload therefore stores exactly one
// record per id with every field — Server_Sequence included — left as it was
// (Req 6.5), and a Tombstone that survives Requirement 9.8 keeps the
// Server_Sequence a pull is already going to serve it under.
//
// An entry is `{ record, clampedFrom }`: the stored record plus, when the clock
// clamp of Requirement 8.8 replaced its Revision_Time, the value that was
// replaced. `clampedFrom` is held beside the record like Server_Sequence is, so
// it never reaches the wire — see `republishedClamp` for what it is for.
// ---------------------------------------------------------------------------

/** True when the only field the two records disagree on is `updatedAt`. */
function sameExceptUpdatedAt(candidate, stored) {
  return canonicalKey({ ...candidate, updatedAt: stored.updatedAt }) === canonicalKey(stored);
}

/**
 * True when this record is a re-send of the payload whose Revision_Time the
 * clamp already replaced, carrying no other change.
 *
 * Requirements 6.5 and 8.8 pull against each other here. The clamp stores the
 * *server* clock, and the clock moves, so pushing one identical far-future
 * payload twice would otherwise store two different Revision_Times: a second
 * clamp to a later instant, or — once the payload's own value has fallen back
 * inside the one-day window — the payload's unclamped value. Either way the
 * stored record would change on a request that carried nothing new, which
 * Requirement 6.5 forbids ("every field other than Server_Sequence equal to its
 * value after the first request").
 *
 * Recognizing the re-send by the Revision_Time the clamp consumed settles it,
 * and settles it narrowly: only a record whose incoming Revision_Time is exactly
 * the value already clamped for this `id`, and which agrees on every other field,
 * is treated as "not a new revision". A genuinely edited record differs on some
 * other field and takes the normal path, so no content is ever held back.
 */
function republishedClamp(entry, incoming, candidate) {
  if (entry === null || entry.clampedFrom === null) return false;
  if (entry.clampedFrom !== incoming.updatedAt) return false;
  return sameExceptUpdatedAt(candidate, entry.record);
}

export function planPush(records, lookup, now) {
  const outcomes = [];
  /** Ids already acknowledged, so a payload repeating an id reports it once. */
  const acknowledged = new Set();
  /** id → the entry to write, in the order the writes will be sequenced. */
  const writes = new Map();
  /** id → the entry currently believed to be stored (staged writes included). */
  const current = new Map();

  for (const incoming of records) {
    const id = incoming.id;
    const entry = current.has(id) ? current.get(id) : (lookup(id) ?? null);
    const stored = entry === null ? null : entry.record;
    const candidate = normalizeForStore(incoming, now);
    const winner = republishedClamp(entry, incoming, candidate)
      ? stored
      : mergeRecords(stored, candidate);

    // Exactly one outcome per id carried by the request (Req 6.11).
    if (!acknowledged.has(id)) {
      acknowledged.add(id);
      outcomes.push({ id, outcome: "stored" });
    }

    if (entry !== null && winner === stored) {
      // The stored record wins on every key the ordering can see, so there is
      // nothing to write and no Server_Sequence to assign.
      current.set(id, entry);
      continue;
    }

    const written = {
      record: winner,
      clampedFrom: wasClamped(incoming.updatedAt, now) ? incoming.updatedAt : null,
    };
    current.set(id, written);
    writes.set(id, written);
  }

  return { outcomes, writes };
}

// ---------------------------------------------------------------------------
// in-memory backend (dev + tests)
//
// Per-process, so it is only suitable for local development — the Firestore
// backend below is what production uses. Sequence allocation is the same
// block allocation the Firestore transaction performs: read `seq`, write all N
// records with `seq + 1 … seq + N`, then write `seq + N`. Here that block runs
// without an intervening `await`, so a concurrent push can never observe a `seq`
// that has advanced past a record it cannot read (Req 6.3, 8.9).
// ---------------------------------------------------------------------------

function newUserState() {
  return {
    records: new Map(), // id → { record, seq, clampedFrom }
    seq: INITIAL_SEQ,
    epoch: INITIAL_EPOCH,
    lastTombstoneSweepAt: null, // tombstone expiry (Req 9.7) — written here
  };
}

/**
 * Drop Tombstones whose Revision_Time is more than the retention period behind
 * the clock (Req 9.7). Once dropped, a pull covering that `id` answers as though
 * no Event_Record ever existed, because nothing is stored under it any more.
 *
 * Records are only ever removed here, so the retention floor is "at least 180
 * days": a Tombstone survives every sweep until it is genuinely older than the
 * window.
 *
 * A record that is not a Tombstone is never dropped by this sweep, which is what
 * Requirement 13.7 asks of the store: a lapsed user's Event_Records are retained
 * indefinitely (Decision D1), so nothing here removes a record on account of
 * entitlement. The only thing that empties a user is `deleteAll`, and only because
 * the user asked (Req 17.1, 17.4).
 *
 * `lastTombstoneSweepAt` records when this last ran, which is also what tells the
 * two backends apart: the Firestore backend does not sweep, so the field stays
 * null there (see the KNOWN DIVERGENCE note below).
 */
function sweepExpiredTombstones(state, now) {
  const cutoff = now - TOMBSTONE_RETENTION_MS;
  for (const [id, entry] of state.records) {
    if (!isTombstone(entry.record)) continue;
    if (!Number.isInteger(entry.record.updatedAt)) continue;
    if (entry.record.updatedAt < cutoff) state.records.delete(id);
  }
  state.lastTombstoneSweepAt = now;
}

export function createMemoryEventStore() {
  const users = new Map();

  const stateFor = (email) => {
    const key = norm(email);
    let state = users.get(key);
    if (!state) {
      state = newUserState();
      users.set(key, state);
    }
    return state;
  };

  return {
    /**
     * Store the records of one validated push request for one user, all in a
     * single atomic step (Req 6.3, 6.4, 6.5, 9.2, 9.5, 9.8).
     *
     * Returns one outcome per id sent and the highest Server_Sequence this
     * request assigned, or `null` when it assigned none (Req 6.11).
     */
    async push(email, records, now = Date.now()) {
      const state = stateFor(email);
      const list = Array.isArray(records) ? records : [];
      const { outcomes, writes } = planPush(list, (id) => state.records.get(id) ?? null, now);

      // Block allocation: read `seq`, assign `seq + 1 … seq + N` in the planned
      // order, then write back `seq + N`. No `await` in between, so the counter
      // and the records it covers become visible together.
      let seq = state.seq;
      for (const [id, written] of writes) {
        state.records.set(id, { ...written, seq: ++seq });
      }
      state.seq = seq;

      return {
        outcomes,
        stored: writes.size,
        highestSequence: writes.size > 0 ? seq : null,
      };
    },

    /**
     * Serve the next page after `cursor`: at most `limit` (≤500) records for this
     * user only, ordered by ascending Server_Sequence, with the cursor to present
     * next and whether more remain (Req 7.2).
     *
     * A cursor from a previous purge generation — or one that is not a cursor at
     * all — is answered with `{ cursorInvalid: true }` and no records, which is
     * the signal the client resets on (Req 13.13, 17.5). An absent cursor means
     * "from the beginning" (Req 7.1, 10.1).
     */
    async pull(email, cursor = null, limit = MAX_PULL_LIMIT, now = Date.now()) {
      const state = stateFor(email);
      sweepExpiredTombstones(state, now);

      let sinceSeq = 0;
      if (cursor !== null && cursor !== undefined && cursor !== "") {
        const parsed = parseCursor(cursor);
        if (parsed === null || parsed.epoch !== state.epoch) {
          return { cursorInvalid: true, records: [], cursor: null, hasMore: false };
        }
        sinceSeq = parsed.sequence;
      }

      const size = pageLimit(limit);
      const candidates = [...state.records.values()]
        .filter((entry) => entry.seq > sinceSeq)
        .sort((a, b) => a.seq - b.seq);
      const page = candidates.slice(0, size);
      const lastSeq = page.length > 0 ? page[page.length - 1].seq : sinceSeq;

      return {
        cursorInvalid: false,
        // Top-level copies, so adding or dropping a field on a served record
        // cannot alter what is stored, and holding no `seq`, which is server-side
        // bookkeeping the wire never carries (Req 8.3, 8.9). Nested values are
        // shared rather than deep-copied: a served page is serialized to JSON and
        // discarded, and cloning 500 records per pull to guard against a mutation
        // no caller performs is not worth the cost.
        records: page.map((entry) => ({ ...entry.record })),
        cursor: formatCursor(state.epoch, lastSeq),
        hasMore: candidates.length > page.length,
      };
    },

    /**
     * Delete every stored Event_Record and Tombstone for the user and bump the
     * purge generation, so every cursor already issued reports invalid on the
     * next pull (Req 17.1, 17.4, 17.5). The user record and its entitlement live
     * in `store.js` and are untouched here.
     */
    async deleteAll(email) {
      const state = stateFor(email);
      const deleted = state.records.size;
      state.records.clear();
      state.seq = INITIAL_SEQ;
      state.epoch += 1;
      return { deleted, epoch: state.epoch };
    },

    /** Stored record count, for the per-user cap (Req 19.7). */
    async countFor(email, now = Date.now()) {
      const state = stateFor(email);
      sweepExpiredTombstones(state, now);
      return state.records.size;
    },

    /** Sync metadata: `{ seq, epoch, lastTombstoneSweepAt }`. */
    async getMeta(email) {
      const state = stateFor(email);
      return {
        seq: state.seq,
        epoch: state.epoch,
        lastTombstoneSweepAt: state.lastTombstoneSweepAt,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Firestore backend removed (Decision D1).
// The SQLite backend lives in `server/sqlite/eventStore.js`.
// ---------------------------------------------------------------------------

let eventStorePromise = null;

/** Memoized event store for the configured backend, mirroring `getStore()`. */
export function getEventStore() {
  if (!eventStorePromise) {
    if (BACKEND === "memory") {
      eventStorePromise = Promise.resolve(createMemoryEventStore());
    } else if (BACKEND === "sqlite") {
      eventStorePromise = (async () => {
        const { DatabaseSync } = await import("node:sqlite");
        const { migrate } = await import("./sqlite/schema.js");
        const { createSqliteEventStore } = await import("./sqlite/eventStore.js");
        const { openDatabase } = await import("./sqlite/open.js");
        const { db } = openDatabase(DatabaseSync);
        migrate(db);
        return createSqliteEventStore(db);
      })();
    } else {
      console.error(
        `Fatal: unrecognised DATASTORE_BACKEND="${BACKEND}". Accepted values: "sqlite", "memory".`
      );
      process.exit(1);
    }
  }
  return eventStorePromise;
}

export { BACKEND };
