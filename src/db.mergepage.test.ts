// Feature: cloud-sync, task 14.4 — the pull half of the sync round trip.
//
// Property 13: Sync is idempotent in both directions (merge half)
//   Merging the same pulled page into the Local_Store more than once, with no
//   intervening local or remote change, leaves the same Log_Events, the same
//   Tombstones, and the same Revision_Time per `id` as after the first merge.
//   **Validates: Requirements 7.6**
//
// Property 19: The cursor advances monotonically and never stalls on a bad record
//   For any sequence of pulled pages, including pages whose records
//   `fromEventRecord` skips, the stored Sync_Cursor after each committed page is
//   strictly greater than before, and a page whose records are all skipped still
//   advances the cursor past them.
//   **Validates: Requirements 7.4, 20.5**
//
// Both properties are about what an actual IndexedDB transaction leaves behind,
// so `fake-indexeddb/auto` installs a real implementation (jsdom has none) and
// every assertion reads the store back through `db.ts`'s own accessors.
//
// fake-indexeddb clones stored values with Node's `structuredClone`, which
// flattens a jsdom `Blob` into an empty object, so photo fixtures use Node's
// `Blob` — it survives the store with its bytes intact (see
// `db.atomicity.test.ts`).
//
// Pages are built with the real `toEventRecord`, so a "valid" record is exactly
// what the Sync_Service would serve, and malformed records come from
// `arbMalformedWireRecord` — the ones Requirements 20.3/20.4 say must be skipped.

import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatCursor, parseCursor, toEventRecord } from "./cloudSync";
import {
  DB_NAME,
  getAllRecords,
  getMeta,
  getOutboxCount,
  mergePulledPage,
  type StoredRecord,
} from "./db";
import {
  MAX_EPOCH_MS,
  arbMalformedWireRecord,
  arbStoredRecord,
  cloneRecord,
  isSyncTombstone,
  type SyncStoredRecord,
} from "./test/arbitraries";

// ---------------------------------------------------------------------------
// Store access
//
// Seeds are written straight into `events` rather than through `putEvent`,
// because these properties need exact `updatedAt` values (a pulled record older
// than, equal to, and newer than the local one are three different merge
// branches) and `putEvent` owns that assignment.
// ---------------------------------------------------------------------------

let rawDb: IDBDatabase | null = null;

async function raw(): Promise<IDBDatabase> {
  if (rawDb) return rawDb;
  // Let `db.ts` open (and upgrade) first, so this connection never creates the
  // database at the wrong version.
  await getOutboxCount();
  rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return rawDb;
}

/** Empty every store, then write the given Local_Store contents verbatim. */
async function resetAndSeed(records: readonly SyncStoredRecord[] = []): Promise<void> {
  const db = await raw();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["events", "outbox", "meta"], "readwrite");
    const events = tx.objectStore("events");
    events.clear();
    tx.objectStore("outbox").clear();
    tx.objectStore("meta").clear();
    for (const record of records) events.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Snapshots
//
// "The same Log_Events, the same Tombstones, and the same Revision_Time per id"
// is asserted as a deep comparison of everything the store holds, including the
// exact set of present keys (so a field appearing or disappearing is caught) and
// the photo bytes (so Requirement 7.7's retention is stable across re-merges).
// ---------------------------------------------------------------------------

interface StoreSnapshot {
  records: Record<string, unknown>;
  outboxCount: number;
}

async function describeRecord(record: StoredRecord): Promise<Record<string, unknown>> {
  const src = record as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {
    // Presence, not just value: `toEqual` cannot tell a missing key from
    // `undefined`, and Requirement 20.6 makes that distinction load-bearing.
    keys: Object.keys(src).sort().join(","),
  };
  for (const key of Object.keys(src).sort()) {
    if (key === "photo") continue;
    out[key] = src[key];
  }
  const photo = src.photo as unknown as NodeBlob | undefined;
  out.photo = photo
    ? `${photo.type}:${photo.size}:${Buffer.from(await photo.arrayBuffer()).toString("hex")}`
    : null;
  return out;
}

async function snapshot(): Promise<StoreSnapshot> {
  const all = await getAllRecords();
  const records: Record<string, unknown> = {};
  for (const record of all) {
    records[record.id] = await describeRecord(record);
  }
  return { records, outboxCount: await getOutboxCount() };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const PHOTO_TYPE = "image/jpeg";

/**
 * A Local_Store record. Any generated jsdom photo is replaced by a Node `Blob`,
 * which is the only kind that survives the store faithfully.
 */
const arbSeedRecord: fc.Arbitrary<SyncStoredRecord> = fc
  .tuple(arbStoredRecord, fc.option(fc.uint8Array({ minLength: 1, maxLength: 16 }), { nil: null }))
  .map(([record, bytes]) => {
    const copy = cloneRecord(record) as unknown as Record<string, unknown>;
    delete copy.photo;
    if (!isSyncTombstone(record) && record.type === "meal" && bytes !== null) {
      // Copy into a plain ArrayBuffer so the Blob part type is unambiguous.
      copy.photo = new NodeBlob([Uint8Array.from(bytes).buffer as ArrayBuffer], {
        type: PHOTO_TYPE,
      }) as unknown as Blob;
    }
    return copy as unknown as SyncStoredRecord;
  });

/** How a pulled record relates to the local entry holding the same `id`. */
type Relation = "echo" | "edited" | "older" | "same" | "newer";

interface PulledSpec {
  record: SyncStoredRecord;
  reuseLocalId: boolean;
  localIndex: number;
  relation: Relation;
}

const arbPulledSpec: fc.Arbitrary<PulledSpec> = fc.record({
  record: arbStoredRecord,
  // Reuse is weighted up: a pulled record that collides with a local one is
  // where the merge rule actually does something.
  reuseLocalId: fc.oneof(
    { arbitrary: fc.constant(true), weight: 3 },
    { arbitrary: fc.constant(false), weight: 1 },
  ),
  localIndex: fc.nat({ max: 32 }),
  relation: fc.constantFrom<Relation>("echo", "edited", "older", "same", "newer"),
});

interface PullScenario {
  local: SyncStoredRecord[];
  /** The page in the order the Sync_Service served it (ascending sequence). */
  page: unknown[];
}

/** Weave the malformed records through the page at deterministic positions. */
function interleave(valid: unknown[], malformed: unknown[], seed: number): unknown[] {
  const page = [...valid];
  malformed.forEach((bad, i) => {
    page.splice((seed + i * 7) % (page.length + 1), 0, bad);
  });
  return page;
}

const arbPullScenario: fc.Arbitrary<PullScenario> = fc
  .tuple(
    fc.array(arbSeedRecord, { maxLength: 8 }),
    fc.array(arbPulledSpec, { maxLength: 10 }),
    fc.array(arbMalformedWireRecord, { maxLength: 4 }),
    fc.nat({ max: 64 }),
  )
  .map(([local, specs, malformed, seed]) => {
    const valid = specs.map(({ record, reuseLocalId, localIndex, relation }) => {
      let source = cloneRecord(record) as SyncStoredRecord & { id: string; updatedAt: number };
      if (reuseLocalId && local.length > 0) {
        const target = local[localIndex % local.length];
        if (relation === "echo" || relation === "edited") {
          // "echo" is the Sync_Service serving back a record this device already
          // holds — the plainest form of a re-merge being a no-op. "edited" is
          // the same record edited on another device: it wins, it is the same
          // kind as the local entry, and so it is the case where Requirement 7.7
          // carries a local Photo onto a winning pulled `meal`.
          source = cloneRecord(target) as typeof source;
          if (relation === "edited") {
            source.updatedAt = Math.min(MAX_EPOCH_MS, target.updatedAt + 1);
            if (!isSyncTombstone(source)) source.note = "edited on another device";
          }
        } else {
          source.id = target.id;
          source.updatedAt =
            relation === "same"
              ? target.updatedAt
              : relation === "older"
                ? Math.max(0, target.updatedAt - 1)
                : Math.min(MAX_EPOCH_MS, target.updatedAt + 1);
        }
      }
      return toEventRecord(source as unknown as StoredRecord) as unknown;
    });
    return { local, page: interleave(valid, malformed, seed) };
  });

/** A wire record the Sync_Service would really serve. */
const arbServedRecord: fc.Arbitrary<unknown> = arbStoredRecord.map(
  (r) => toEventRecord(r as unknown as StoredRecord) as unknown,
);

/** One pulled page plus how far its Server_Sequence advances. */
interface PageStep {
  records: unknown[];
  delta: number;
}

const arbPageStep: fc.Arbitrary<PageStep> = fc.record({
  records: fc.oneof(
    { arbitrary: fc.array(arbServedRecord, { maxLength: 6 }), weight: 3 },
    // A page nothing in which can be deserialized: the stall case (Req 20.5).
    {
      arbitrary: fc.array(arbMalformedWireRecord, { minLength: 1, maxLength: 6 }),
      weight: 2,
    },
    {
      arbitrary: fc
        .tuple(
          fc.array(arbServedRecord, { maxLength: 5 }),
          fc.array(arbMalformedWireRecord, { maxLength: 3 }),
          fc.nat({ max: 32 }),
        )
        .map(([valid, bad, seed]) => interleave(valid, bad, seed)),
      weight: 2,
    },
    // An empty page still commits a cursor (Req 7.8).
    { arbitrary: fc.constant(null).map(() => [] as unknown[]), weight: 1 },
  ),
  delta: fc.integer({ min: 1, max: 500 }),
});

// ---------------------------------------------------------------------------
// Property 13 (merge half)
// ---------------------------------------------------------------------------

describe("Property 13: Sync is idempotent in both directions (merge half)", () => {
  it("re-merging the same page leaves the same records, tombstones, and Revision_Times", async () => {
    await fc.assert(
      fc.asyncProperty(arbPullScenario, async ({ local, page }) => {
        await resetAndSeed(local);

        const cursor = formatCursor(1, 42);
        const first = await mergePulledPage(page, cursor);
        const afterFirst = await snapshot();

        // No intervening local or remote change: the very same page, again.
        const second = await mergePulledPage(page, cursor);
        expect(await snapshot()).toEqual(afterFirst);
        // A record that changed nothing is not reported as changed, which is
        // what keeps the Requirement 7.10 refresh quiet on a repeat.
        expect(second.changedIds).toEqual([]);
        expect(second.merged).toBe(first.merged);
        expect(second.skipped).toBe(first.skipped);

        // And again, so stability is not an artefact of the second pass.
        const third = await mergePulledPage(page, cursor);
        expect(await snapshot()).toEqual(afterFirst);
        expect(third.changedIds).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

describe("Property 19: the cursor advances monotonically and never stalls", () => {
  it("commits the cursor of each page and advances strictly across a sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbPageStep, { minLength: 1, maxLength: 8 }),
        fc.array(arbSeedRecord, { maxLength: 4 }),
        async (steps, local) => {
          await resetAndSeed(local);
          const epoch = 7;
          let previous = 0;

          for (const { records, delta } of steps) {
            const sequence = previous + delta;
            const cursor = formatCursor(epoch, sequence);

            const result = await mergePulledPage(records, cursor);
            // Every record is accounted for: merged or skipped, never dropped
            // silently and never fatal (Req 20.3, 20.4).
            expect(result.merged + result.skipped).toBe(records.length);

            const stored = await getMeta<string>("cursor");
            expect(stored).toBe(cursor);

            const parsed = parseCursor(stored ?? null);
            expect(parsed).not.toBeNull();
            expect(parsed!.epoch).toBe(epoch);
            expect(parsed!.sequence).toBeGreaterThan(previous);
            previous = parsed!.sequence;
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("advances past a page whose every record is malformed, leaving the store untouched", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbMalformedWireRecord, { minLength: 1, maxLength: 8 }),
        fc.array(arbSeedRecord, { maxLength: 5 }),
        async (bad, local) => {
          await resetAndSeed(local);
          const before = await snapshot();

          const result = await mergePulledPage(bad, formatCursor(3, 900));

          // Skipped, counted, and the cycle completes rather than failing
          // (Req 20.5) — so the same page is never re-fetched forever.
          expect(result.merged).toBe(0);
          expect(result.skipped).toBe(bad.length);
          expect(result.changedIds).toEqual([]);
          expect(await getMeta<string>("cursor")).toBe(formatCursor(3, 900));
          // The Local_Store is unchanged for every skipped `id` (Req 20.3, 20.4).
          expect(await snapshot()).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});
