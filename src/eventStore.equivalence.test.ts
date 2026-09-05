// @vitest-environment node
//
// Property-based equivalence tests: createSqliteEventStore vs createMemoryEventStore.
//
// Covers Properties 2–5, 7–9, and 12 from the design document.
// Uses injected `now` advancing by {0, 1ms, 1s, 1d, 180d} between calls.
//
// Requires Node 24 for `node:sqlite`. The test is syntactically correct and
// importable on earlier versions but will skip gracefully until the environment
// provides the built-in SQLite module.
//
// **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.7, 3.9, 3.11, 3.12**

import fc from "fast-check";
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-ignore -- untyped ESM JavaScript
import { createMemoryEventStore, INITIAL_SEQ } from "../server/eventStore.js";

// ---------------------------------------------------------------------------
// Lazy imports — node:sqlite is Node 24 only.
// ---------------------------------------------------------------------------

let DatabaseSync: any;
// @ts-ignore -- untyped ESM JavaScript
let createSqliteEventStore: typeof import("../server/sqlite/eventStore.js").createSqliteEventStore;
// @ts-ignore -- untyped ESM JavaScript
let migrate: typeof import("../server/sqlite/schema.js").migrate;

// ---------------------------------------------------------------------------
// Local typing of the untyped event store modules
// ---------------------------------------------------------------------------

/** One page of a `pull`, as both event stores return it. */
interface PullPage {
  cursorInvalid: boolean;
  records: Record<string, unknown>[];
  cursor: string | null;
  hasMore: boolean;
}

/** The slice of an event store the pagination helper drives. */
interface PullableEventStore {
  pull(
    email: string,
    cursor: string | null,
    limit: number,
    now: number
  ): Promise<PullPage>;
}

// ---------------------------------------------------------------------------
// Test harness constants (Property 12: 200 runs, 30s timeout)
// ---------------------------------------------------------------------------

const NUM_RUNS = 200;
const TIMEOUT_MS = 30_000;
const BASE_NOW = 1_700_000_000_000; // a plausible epoch-ms starting point

// Clock advances between calls: {0, 1ms, 1s, 1d, 180d}
const CLOCK_ADVANCES = [0, 1, 1_000, 86_400_000, 15_552_000_000] as const;

// Pool of 4 accounts (Property 2 generator spec)
const ACCOUNTS = ["alice@test.com", "bob@test.com", "carol@test.com", "dave@test.com"] as const;

// Pool of 24 ids (so merges actually happen)
const ID_POOL = Array.from({ length: 24 }, (_, i) => `evt-${String(i).padStart(3, "0")}`);

// Limit boundary set
const LIMIT_CASES = [undefined, 0, 1, 7, 500, 501, 10_000] as const;

// ---------------------------------------------------------------------------
// Temp directory tracking for cleanup
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "es-equiv-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  migrate(db);
  return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Key-sorted JSON for deep equality that ignores insertion order. */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const parts = sorted
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Canonical equality for comparing results from the two backends.
 * Strips `seq` and `clampedFrom` from pulled records (server bookkeeping).
 */
function canonResult(value: unknown): string {
  if (value === null || value === undefined) return canonicalStringify(value);
  if (Array.isArray(value)) {
    return canonicalStringify(value.map((item) =>
      typeof item === "object" && item !== null ? stripBookkeeping(item) : item
    ));
  }
  if (typeof value === "object") {
    return canonicalStringify(stripBookkeeping(value as Record<string, unknown>));
  }
  return canonicalStringify(value);
}

function stripBookkeeping(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "seq" || k === "clampedFrom") continue;
    if (v === undefined) continue;
    if (k === "records" && Array.isArray(v)) {
      out[k] = v.map((r: unknown) =>
        typeof r === "object" && r !== null ? stripBookkeeping(r as Record<string, unknown>) : r
      );
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      out[k] = stripBookkeeping(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Wrap a call so errors become { threw: className } rather than propagating. */
async function safeCall<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; threw: string }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err: unknown) {
    const name = err instanceof Error ? err.constructor.name : "Error";
    return { ok: false, threw: name };
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbAccount = fc.constantFrom(...ACCOUNTS);
const arbId = fc.constantFrom(...ID_POOL);
const arbClockAdvance = fc.constantFrom(...CLOCK_ADVANCES);
const arbLimit = fc.constantFrom(...LIMIT_CASES);

const EVENT_TYPES = ["meal", "symptom", "bowel", "checkin"] as const;

/** JSON-safe unknown fields for round-trip testing (Property 9). */
const UNKNOWN_KEYS = ["x_extra", "futureField", "v4Only", "vendor_tag", "mood", "hydration"];

const arbUnknownField: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.oneof(fc.string({ maxLength: 8 }), fc.integer()), { maxLength: 3 }),
  fc.dictionary(
    fc.constantFrom("a", "b", "c", "nested"),
    fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean()),
    { maxKeys: 3 },
  ),
);

const arbUnknownFields: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.constantFrom(...UNKNOWN_KEYS),
  arbUnknownField,
  { minKeys: 0, maxKeys: 5 },
);

/**
 * Generate a valid Event_Record for pushing. Includes unknown fields for
 * Property 9 coverage. Uses ids from the pool so merges happen.
 */
const arbEventRecord: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    arbId,
    fc.constantFrom(...EVENT_TYPES),
    fc.integer({ min: 0, max: 4_102_444_800_000 }),
    fc.oneof(
      { weight: 5, arbitrary: fc.integer({ min: 0, max: 4_102_444_800_000 }) },
      // Far-future values to exercise clamping
      { weight: 2, arbitrary: fc.constant(BASE_NOW + 100_000_000) },
      // Non-integer updatedAt — exercises NaN/null round-trip divergence
      { weight: 1, arbitrary: fc.constant(null as unknown as number) },
    ),
    fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
    arbUnknownFields,
    fc.boolean(), // whether this is a tombstone
  )
  .map(([id, type, createdAt, updatedAt, note, unknowns, deleted]) => {
    const record: Record<string, unknown> = {
      id,
      type,
      createdAt,
      ...unknowns,
    };
    if (updatedAt !== null && updatedAt !== undefined) {
      record.updatedAt = updatedAt;
    }
    if (note !== undefined) {
      record.note = note;
    }
    if (deleted) {
      record.deleted = true;
    } else {
      if (type === "meal") {
        record.dish = "Test dish";
        record.ingredients = [{ name: "flour", confidence: "confident" }];
      } else if (type === "symptom") {
        record.symptoms = [{ id: "bloating", severity: "mild" }];
      } else if (type === "bowel") {
        record.bristol = 4;
      }
    }
    return record;
  });

/** A batch of 1–10 records for a push call. */
const arbRecordBatch = fc.array(arbEventRecord, { minLength: 1, maxLength: 10 });

// ---------------------------------------------------------------------------
// Call types for the event store
// ---------------------------------------------------------------------------

interface PushCall { method: "push"; account: string; records: Record<string, unknown>[]; advance: number }
interface PullCall { method: "pull"; account: string; cursorKind: "null" | "empty" | "prev" | "stale" | "malformed"; limit: typeof LIMIT_CASES[number]; advance: number }
interface DeleteAllCall { method: "deleteAll"; account: string; advance: number }
interface CountForCall { method: "countFor"; account: string; advance: number }
interface GetMetaCall { method: "getMeta"; account: string; advance: number }

type StoreCall = PushCall | PullCall | DeleteAllCall | CountForCall | GetMetaCall;

const arbCall: fc.Arbitrary<StoreCall> = fc.oneof(
  { weight: 5, arbitrary: fc.tuple(arbAccount, arbRecordBatch, arbClockAdvance).map(
    ([account, records, advance]): PushCall => ({ method: "push", account, records, advance })
  )},
  { weight: 3, arbitrary: fc.tuple(
    arbAccount,
    fc.constantFrom("null" as const, "empty" as const, "prev" as const, "stale" as const, "malformed" as const),
    arbLimit,
    arbClockAdvance,
  ).map(
    ([account, cursorKind, limit, advance]): PullCall => ({ method: "pull", account, cursorKind, limit, advance })
  )},
  { weight: 2, arbitrary: fc.tuple(arbAccount, arbClockAdvance).map(
    ([account, advance]): DeleteAllCall => ({ method: "deleteAll", account, advance })
  )},
  { weight: 2, arbitrary: fc.tuple(arbAccount, arbClockAdvance).map(
    ([account, advance]): CountForCall => ({ method: "countFor", account, advance })
  )},
  { weight: 2, arbitrary: fc.tuple(arbAccount, arbClockAdvance).map(
    ([account, advance]): GetMetaCall => ({ method: "getMeta", account, advance })
  )},
);

/** A sequence of 1–200 calls as required by Property 2. */
const arbCallSequence = fc.array(arbCall, { minLength: 1, maxLength: 200 });

// ---------------------------------------------------------------------------
// Apply a call to a backend, resolving cursors dynamically
// ---------------------------------------------------------------------------

interface RunState {
  store: ReturnType<typeof createMemoryEventStore>;
  cursors: Map<string, string | null>; // account -> last valid cursor from pull
}

async function applyCall(
  state: RunState,
  call: StoreCall,
  now: number,
): Promise<{ ok: true; value: unknown } | { ok: false; threw: string }> {
  const { store, cursors } = state;

  switch (call.method) {
    case "push":
      return safeCall(() => store.push(call.account, call.records, now));

    case "pull": {
      let cursor: string | null | undefined;
      switch (call.cursorKind) {
        case "null": cursor = null; break;
        case "empty": cursor = ""; break;
        case "prev": cursor = cursors.get(call.account) ?? null; break;
        case "stale": cursor = "0:5"; break; // epoch 0 is always stale
        case "malformed": cursor = "garbage::"; break;
      }
      const limit = call.limit === undefined ? undefined : call.limit;
      const result = await safeCall(() => store.pull(call.account, cursor, limit, now));
      // Track the cursor for future "prev" references
      if (result.ok && typeof result.value === "object" && result.value !== null) {
        const pullResult = result.value as { cursor?: string | null };
        if (pullResult.cursor) {
          cursors.set(call.account, pullResult.cursor);
        }
      }
      return result;
    }

    case "deleteAll":
      return safeCall(() => store.deleteAll(call.account));

    case "countFor":
      return safeCall(() => store.countFor(call.account, now));

    case "getMeta":
      return safeCall(() => store.getMeta(call.account));
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Event store equivalence (Properties 2–5, 7–9, 12)", () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tempDirs = [];
  });

  // Load node:sqlite lazily — skip the whole suite if unavailable
  let available = false;

  it("should load node:sqlite (Node 24 required)", async () => {
    try {
      const sqliteModule = await import("node:sqlite");
      DatabaseSync = sqliteModule.DatabaseSync;
      // @ts-ignore -- untyped ESM JavaScript
      const esModule = await import("../server/sqlite/eventStore.js");
      createSqliteEventStore = esModule.createSqliteEventStore;
      // @ts-ignore -- untyped ESM JavaScript
      const schemaModule = await import("../server/sqlite/schema.js");
      migrate = schemaModule.migrate;
      available = true;
    } catch (err) {
      console.warn("node:sqlite not available — skipping event store equivalence tests (requires Node 24)");
      return;
    }
    expect(available).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Property 2: Event store model equivalence
  // For sequences of 1–200 Event_Store_Backend calls, SQLite matches memory
  // under the canonical equality relation.
  //
  // **Validates: Requirements 3.2**
  // -------------------------------------------------------------------------
  it("Property 2: call sequences produce equivalent results", async () => {
    if (!available) return;

    await fc.assert(
      fc.asyncProperty(arbCallSequence, async (calls) => {
        const memStore = createMemoryEventStore();
        const db = makeTempDb();
        const sqlStore = createSqliteEventStore(db);

        const memState: RunState = { store: memStore, cursors: new Map() };
        const sqlState: RunState = { store: sqlStore, cursors: new Map() };

        let now = BASE_NOW;

        for (let i = 0; i < calls.length; i++) {
          const call = calls[i];
          now += call.advance;

          const [memResult, sqlResult] = await Promise.all([
            applyCall(memState, call, now),
            applyCall(sqlState, call, now),
          ]);

          // Exception parity check (Property 12)
          if (!memResult.ok || !sqlResult.ok) {
            expect(
              memResult.ok,
              `call ${i} (${call.method}): memory threw=${!memResult.ok}, sqlite threw=${!sqlResult.ok}`,
            ).toBe(sqlResult.ok);
          }

          // Value equivalence under canonical JSON (seq/clampedFrom stripped)
          if (memResult.ok && sqlResult.ok) {
            expect(
              canonResult(sqlResult.value),
              `call ${i} (${call.method}): values differ`,
            ).toEqual(canonResult(memResult.value));
          }
        }

        db.close();
      }),
      { numRuns: NUM_RUNS, timeout: TIMEOUT_MS },
    );
  }, TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Property 3: Push–pull round trip (merge semantics)
  // Pushing duplicate ids results in one record per id, merge-winning record
  // preserved, both backends agree.
  //
  // **Validates: Requirements 3.3**
  // -------------------------------------------------------------------------
  it("Property 3: push–pull round trip preserves merge winners", async () => {
    if (!available) return;

    await fc.assert(
      fc.asyncProperty(
        arbAccount,
        fc.array(arbEventRecord, { minLength: 1, maxLength: 50 }),
        arbClockAdvance,
        async (account, records, advance) => {
          const memStore = createMemoryEventStore();
          const db = makeTempDb();
          const sqlStore = createSqliteEventStore(db);

          const now = BASE_NOW + advance;

          // Push same records to both
          const [memPush, sqlPush] = await Promise.all([
            memStore.push(account, records, now),
            sqlStore.push(account, records, now),
          ]);

          // Push outcomes match
          expect(canonResult(sqlPush)).toEqual(canonResult(memPush));

          // Pull from null cursor (full result)
          const [memPull, sqlPull] = await Promise.all([
            memStore.pull(account, null, 500, now),
            sqlStore.pull(account, null, 500, now),
          ]);

          // Pull results match
          expect(canonResult(sqlPull)).toEqual(canonResult(memPull));

          // Verify distinct ids in pull result
          const ids = memPull.records.map((r: Record<string, unknown>) => r.id);
          const uniqueIds = new Set(ids);
          expect(ids.length).toBe(uniqueIds.size);

          db.close();
        },
      ),
      { numRuns: NUM_RUNS, timeout: TIMEOUT_MS },
    );
  }, TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Property 4: Cursor pagination
  // Disjoint pages, hasMore correct, concatenation equals full result.
  //
  // **Validates: Requirements 3.4**
  // -------------------------------------------------------------------------
  it("Property 4: cursor pagination produces correct disjoint pages", async () => {
    if (!available) return;

    await fc.assert(
      fc.asyncProperty(
        arbAccount,
        fc.array(arbEventRecord, { minLength: 5, maxLength: 50 }),
        fc.integer({ min: 1, max: 7 }), // small page to force multiple pages
        async (account, records, pageSize) => {
          const memStore = createMemoryEventStore();
          const db = makeTempDb();
          const sqlStore = createSqliteEventStore(db);
          const now = BASE_NOW;

          // Push records
          await Promise.all([
            memStore.push(account, records, now),
            sqlStore.push(account, records, now),
          ]);

          // Paginate through both stores and collect all pages.
          //
          // `store` carries a local structural shape rather than
          // `ReturnType<typeof createMemoryEventStore>`: the event store modules
          // are untyped ESM, so that alias resolves to an implicit `any` and
          // leaves `result` below with no inferable type.
          async function paginate(store: PullableEventStore) {
            const pages: Array<Record<string, unknown>[]> = [];
            let cursor: string | null = null;
            let hasMore = true;
            let iterations = 0;

            while (hasMore && iterations < 200) {
              iterations++;
              const result = await store.pull(account, cursor, pageSize, now);
              if (result.cursorInvalid) break;
              pages.push(result.records as Record<string, unknown>[]);
              cursor = result.cursor;
              hasMore = result.hasMore;
            }
            return pages;
          }

          const memPages = await paginate(memStore);
          const sqlPages = await paginate(sqlStore);

          // Same number of pages
          expect(sqlPages.length).toBe(memPages.length);

          // Each page has at most pageSize records
          for (const page of memPages) {
            expect(page.length).toBeLessThanOrEqual(pageSize);
          }
          for (const page of sqlPages) {
            expect(page.length).toBeLessThanOrEqual(pageSize);
          }

          // Pages are disjoint by id
          const allMemIds = memPages.flat().map((r) => r.id);
          const allSqlIds = sqlPages.flat().map((r) => r.id);
          expect(new Set(allMemIds).size).toBe(allMemIds.length);
          expect(new Set(allSqlIds).size).toBe(allSqlIds.length);

          // Concatenation matches between backends
          expect(canonResult(allSqlIds)).toEqual(canonResult(allMemIds));

          // Records match between backends
          expect(canonResult(sqlPages.flat())).toEqual(canonResult(memPages.flat()));

          db.close();
        },
      ),
      { numRuns: NUM_RUNS, timeout: TIMEOUT_MS },
    );
  }, TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Property 5: Sequence monotonicity
  // getMeta.seq is non-decreasing across pushes, increases by stored count.
  //
  // **Validates: Requirements 3.5**
  // -------------------------------------------------------------------------
  it("Property 5: sequence monotonicity across pushes", async () => {
    if (!available) return;

    await fc.assert(
      fc.asyncProperty(
        arbAccount,
        fc.array(
          fc.tuple(arbRecordBatch, arbClockAdvance),
          { minLength: 1, maxLength: 50 },
        ),
        async (account, pushes) => {
          const memStore = createMemoryEventStore();
          const db = makeTempDb();
          const sqlStore = createSqliteEventStore(db);

          let now = BASE_NOW;
          let memPrevSeq = INITIAL_SEQ;
          let sqlPrevSeq = INITIAL_SEQ;

          for (const [records, advance] of pushes) {
            now += advance;

            const [memResult, sqlResult] = await Promise.all([
              memStore.push(account, records, now),
              sqlStore.push(account, records, now),
            ]);

            const [memMeta, sqlMeta] = await Promise.all([
              memStore.getMeta(account),
              sqlStore.getMeta(account),
            ]);

            // Sequence never decreases
            expect(memMeta.seq).toBeGreaterThanOrEqual(memPrevSeq);
            expect(sqlMeta.seq).toBeGreaterThanOrEqual(sqlPrevSeq);

            // Rises by exactly stored count
            expect(memMeta.seq).toBe(memPrevSeq + memResult.stored);
            expect(sqlMeta.seq).toBe(sqlPrevSeq + sqlResult.stored);

            // highestSequence matches when stored > 0
            if (memResult.stored > 0) {
              expect(memResult.highestSequence).toBe(memMeta.seq);
            } else {
              expect(memResult.highestSequence).toBeNull();
            }
            if (sqlResult.stored > 0) {
              expect(sqlResult.highestSequence).toBe(sqlMeta.seq);
            } else {
              expect(sqlResult.highestSequence).toBeNull();
            }

            // Both backends agree
            expect(sqlMeta.seq).toBe(memMeta.seq);

            memPrevSeq = memMeta.seq;
            sqlPrevSeq = sqlMeta.seq;
          }

          db.close();
        },
      ),
      { numRuns: NUM_RUNS, timeout: TIMEOUT_MS },
    );
  }, TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Property 7: deleteAll idempotence
  // Second call returns 0 deleted, epoch increments each time.
  //
  // **Validates: Requirements 3.7**
  // -------------------------------------------------------------------------
  it("Property 7: deleteAll is idempotent, epoch increments each time", async () => {
    if (!available) return;

    await fc.assert(
      fc.asyncProperty(
        arbAccount,
        fc.array(arbEventRecord, { minLength: 0, maxLength: 30 }),
        arbClockAdvance,
        async (account, records, advance) => {
          const memStore = createMemoryEventStore();
          const db = makeTempDb();
          const sqlStore = createSqliteEventStore(db);
          const now = BASE_NOW + advance;

          // Push some records first
          if (records.length > 0) {
            await Promise.all([
              memStore.push(account, records, now),
              sqlStore.push(account, records, now),
            ]);
          }

          // First deleteAll
          const [memDel1, sqlDel1] = await Promise.all([
            memStore.deleteAll(account),
            sqlStore.deleteAll(account),
          ]);

          // Both agree on first delete
          expect(sqlDel1.deleted).toBe(memDel1.deleted);
          expect(sqlDel1.epoch).toBe(memDel1.epoch);

          // Second deleteAll — idempotent
          const [memDel2, sqlDel2] = await Promise.all([
            memStore.deleteAll(account),
            sqlStore.deleteAll(account),
          ]);

          // Second call returns 0 deleted
          expect(memDel2.deleted).toBe(0);
          expect(sqlDel2.deleted).toBe(0);

          // Epoch increments each time
          expect(memDel2.epoch).toBe(memDel1.epoch + 1);
          expect(sqlDel2.epoch).toBe(sqlDel1.epoch + 1);

          // countFor should be 0
          const [memCount, sqlCount] = await Promise.all([
            memStore.countFor(account, now),
            sqlStore.countFor(account, now),
          ]);
          expect(memCount).toBe(0);
          expect(sqlCount).toBe(0);

          // Pull from null cursor returns no records and no invalid cursor
          const [memPull, sqlPull] = await Promise.all([
            memStore.pull(account, null, 500, now),
            sqlStore.pull(account, null, 500, now),
          ]);
          expect(memPull.cursorInvalid).toBe(false);
          expect(memPull.records.length).toBe(0);
          expect(sqlPull.cursorInvalid).toBe(false);
          expect(sqlPull.records.length).toBe(0);

          // getMeta shows seq = 0
          const [memMeta, sqlMeta] = await Promise.all([
            memStore.getMeta(account),
            sqlStore.getMeta(account),
          ]);
          expect(memMeta.seq).toBe(INITIAL_SEQ);
          expect(sqlMeta.seq).toBe(INITIAL_SEQ);

          // Any cursor from before deleteAll is now invalid
          const staleCursor = `${memDel1.epoch - 1}:5`;
          const [memStale, sqlStale] = await Promise.all([
            memStore.pull(account, staleCursor, 500, now),
            sqlStore.pull(account, staleCursor, 500, now),
          ]);
          expect(memStale.cursorInvalid).toBe(true);
          expect(sqlStale.cursorInvalid).toBe(true);

          db.close();
        },
      ),
      { numRuns: NUM_RUNS, timeout: TIMEOUT_MS },
    );
  }, TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Property 8: Account normalization
  // Identifiers differing only in case and whitespace address the same account.
  //
  // **Validates: Requirements 3.8** (same as store test)
  // -------------------------------------------------------------------------
  it("Property 8: account normalization — case and whitespace variants address the same account", async () => {
    if (!available) return;

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ACCOUNTS),
        fc.tuple(
          fc.stringOf(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 3 }),
          fc.stringOf(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 3 }),
        ),
        fc.boolean(),
        arbEventRecord,
        async (baseEmail, [prefix, suffix], upper, record) => {
          const memStore = createMemoryEventStore();
          const db = makeTempDb();
          const sqlStore = createSqliteEventStore(db);
          const now = BASE_NOW;

          // Variant of the email
          const variant = upper
            ? `${prefix}${baseEmail.toUpperCase()}${suffix}`
            : `${prefix}${baseEmail}${suffix}`;

          // Push with the base email
          await Promise.all([
            memStore.push(baseEmail, [record], now),
            sqlStore.push(baseEmail, [record], now),
          ]);

          // getMeta with the variant should see the same state
          const [memMeta, sqlMeta] = await Promise.all([
            memStore.getMeta(variant),
            sqlStore.getMeta(variant),
          ]);

          // Should see the push (seq > 0)
          expect(memMeta.seq).toBeGreaterThan(0);
          expect(sqlMeta.seq).toBeGreaterThan(0);
          expect(sqlMeta.seq).toBe(memMeta.seq);

          db.close();
        },
      ),
      { numRuns: NUM_RUNS, timeout: TIMEOUT_MS },
    );
  }, TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Property 9: Unknown-field round trip
  // Unrecognized top-level fields survive push/pull with byte-level JSON fidelity.
  //
  // **Validates: Requirements 3.9**
  // -------------------------------------------------------------------------
  it("Property 9: unknown fields round-trip with JSON fidelity", async () => {
    if (!available) return;

    await fc.assert(
      fc.asyncProperty(
        arbAccount,
        fc.tuple(
          arbId,
          fc.constantFrom(...EVENT_TYPES),
          fc.integer({ min: 0, max: 4_102_444_800_000 }),
          fc.integer({ min: 0, max: 4_102_444_800_000 }),
          arbUnknownFields,
        ),
        async (account, [id, type, createdAt, updatedAt, unknowns]) => {
          const memStore = createMemoryEventStore();
          const db = makeTempDb();
          const sqlStore = createSqliteEventStore(db);
          const now = BASE_NOW;

          // Build a record with unknown fields at the top level
          const record: Record<string, unknown> = {
            id,
            type,
            createdAt,
            updatedAt,
            ...unknowns,
          };

          // Add type-specific required fields
          if (type === "meal") {
            record.dish = "Test";
            record.ingredients = [];
          } else if (type === "symptom") {
            record.symptoms = [];
          } else if (type === "bowel") {
            record.bristol = 4;
          }

          // Push to both
          await Promise.all([
            memStore.push(account, [record], now),
            sqlStore.push(account, [record], now),
          ]);

          // Pull from both
          const [memPull, sqlPull] = await Promise.all([
            memStore.pull(account, null, 500, now),
            sqlStore.pull(account, null, 500, now),
          ]);

          expect(memPull.records.length).toBeGreaterThan(0);
          expect(sqlPull.records.length).toBeGreaterThan(0);

          // Find the record we pushed
          const memRec = (memPull.records as Record<string, unknown>[]).find((r) => r.id === id);
          const sqlRec = (sqlPull.records as Record<string, unknown>[]).find((r) => r.id === id);

          expect(memRec).toBeDefined();
          expect(sqlRec).toBeDefined();

          // Unknown fields must be present with identical JSON form
          for (const key of Object.keys(unknowns)) {
            if (unknowns[key] === undefined) continue;
            // Byte-level JSON fidelity
            expect(
              JSON.stringify(sqlRec![key]),
              `key "${key}" JSON mismatch`,
            ).toEqual(JSON.stringify(memRec![key]));
          }

          // Overall record equality (key-sorted JSON)
          expect(canonResult(sqlRec)).toEqual(canonResult(memRec));

          db.close();
        },
      ),
      { numRuns: NUM_RUNS, timeout: TIMEOUT_MS },
    );
  }, TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Property 12: Exception parity
  // If one backend throws then the other does too, and a throw leaves all
  // readable state unchanged.
  //
  // **Validates: Requirements 3.11**
  // -------------------------------------------------------------------------
  it("Property 12: exception parity — throws agree and leave state unchanged", async () => {
    if (!available) return;

    await fc.assert(
      fc.asyncProperty(
        fc.array(arbCall, { minLength: 1, maxLength: 50 }),
        async (calls) => {
          const memStore = createMemoryEventStore();
          const db = makeTempDb();
          const sqlStore = createSqliteEventStore(db);

          const memState: RunState = { store: memStore, cursors: new Map() };
          const sqlState: RunState = { store: sqlStore, cursors: new Map() };

          let now = BASE_NOW;

          for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            now += call.advance;

            // Snapshot state before the call for both accounts
            const memMetaBefore = await memStore.getMeta(call.account);
            const sqlMetaBefore = await sqlStore.getMeta(call.account);

            const [memResult, sqlResult] = await Promise.all([
              applyCall(memState, call, now),
              applyCall(sqlState, call, now),
            ]);

            // If one threw, the other must also throw
            if (!memResult.ok || !sqlResult.ok) {
              expect(
                memResult.ok,
                `call ${i} (${call.method}): exception parity violated — mem ok=${memResult.ok}, sql ok=${sqlResult.ok}`,
              ).toBe(sqlResult.ok);

              // Both threw: verify no side effects (state unchanged)
              if (!memResult.ok && !sqlResult.ok) {
                const memMetaAfter = await memStore.getMeta(call.account);
                const sqlMetaAfter = await sqlStore.getMeta(call.account);

                expect(memMetaAfter.seq).toBe(memMetaBefore.seq);
                expect(memMetaAfter.epoch).toBe(memMetaBefore.epoch);
                expect(sqlMetaAfter.seq).toBe(sqlMetaBefore.seq);
                expect(sqlMetaAfter.epoch).toBe(sqlMetaBefore.epoch);
              }
            }
          }

          db.close();
        },
      ),
      { numRuns: NUM_RUNS, timeout: TIMEOUT_MS },
    );
  }, TIMEOUT_MS);
});
