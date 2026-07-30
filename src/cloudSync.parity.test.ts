// Property 5: The client and server merge rules agree.
//
// Validates: Requirements 8.1, 8.2, 8.3, 8.4
//
// `src/cloudSync.ts` and `server/eventStore.js` hold two separate copies of the
// merge rule — one TypeScript, one plain ESM JavaScript. Requirement 8 states
// every criterion of the rule for "THE SnapGut_App and THE Sync_Service" jointly,
// so the two copies agreeing is itself a requirement, and because they are
// separate code that agreement has to be *asserted over generated inputs* rather
// than assumed from a shared import.
//
// The two sides do not hold the same shape, and the test does not pretend they
// do. A client record keeps fields from a newer schemaVersion inside an
// `unknownFields` container and may carry a Photo Blob; a server-stored record is
// the wire record, with those fields inline at the top level and no Photo at all.
// So each generated client record is projected to the server-stored form it would
// arrive as, and the projection is `toWireLike` from the generators plus the
// server's own `normalizeForStore` — deliberately *not* the client's
// `toEventRecord`, so a bug in the client codec cannot mask a divergence. One
// test does additionally run the real push projection (`toEventRecord`), since
// that is the shape the Sync_Service actually stores.
//
// The container asymmetry is verified rather than assumed: the first test asserts
// the two `canonicalKey` implementations derive the same string for the same
// event, which is what makes the Requirement 8.3 tie-breaking ordering "a single
// total ordering ... that the SnapGut_App and the Sync_Service both apply
// identically". If it ever fails, the counterexample is the finding — it must not
// be normalized away by teaching the test to fold the container itself.
//
// The clock clamp of Requirement 8.8 is server-only and out of scope here, so
// `normalizeForStore` is called with a `now` far enough ahead that no generated
// Revision_Time is ever clamped. Task 10.1's own tests cover the clamp.

import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalKey as clientCanonicalKey,
  compareForMerge as clientCompareForMerge,
  mergeRecords as clientMergeRecords,
  toEventRecord,
} from "./cloudSync";
import type { StoredRecord } from "./db";
import {
  arbRecordPair,
  arbRecordTriple,
  arbStoredRecord,
  cloneRecord,
  MAX_EPOCH_MS,
  toWireLike,
  type SyncStoredRecord,
} from "./test/arbitraries";

// ---------------------------------------------------------------------------
// The server module
//
// Untyped ESM JavaScript outside tsconfig's `src` include, imported here for its
// merge rule only. Vitest resolves and runs it directly; the surface below is the
// contract task 10.1 exports.
// ---------------------------------------------------------------------------

type ServerRecord = Record<string, unknown>;

interface ServerMergeModule {
  canonicalKey(record: ServerRecord): string;
  compareForMerge(a: ServerRecord, b: ServerRecord): number;
  mergeRecords(a: ServerRecord | null, b: ServerRecord | null): ServerRecord | null;
  isTombstone(record: unknown): boolean;
  normalizeForStore(record: ServerRecord, now?: number): ServerRecord;
}

let server: ServerMergeModule;

beforeAll(async () => {
  // The module has no type declarations, so the import is suppressed and the
  // local `ServerMergeModule` shape above is what types it here.
  // @ts-ignore -- untyped ESM JavaScript (server/ is not TypeScript)
  server = (await import("../server/eventStore.js")) as unknown as ServerMergeModule;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A server clock far enough ahead that `clampUpdatedAt` never fires for a
 * generated Revision_Time (which is at most `MAX_EPOCH_MS`), so the clamp of
 * Requirement 8.8 stays out of this property.
 */
const NO_CLAMP_NOW = MAX_EPOCH_MS;

/** The client rule, over the generator's structural record type. */
function clientCompare(a: SyncStoredRecord, b: SyncStoredRecord): -1 | 0 | 1 {
  return clientCompareForMerge(a as StoredRecord, b as StoredRecord);
}

function clientMerge(
  a: SyncStoredRecord | null,
  b: SyncStoredRecord | null,
): SyncStoredRecord | null {
  return clientMergeRecords(
    a as StoredRecord | null,
    b as StoredRecord | null,
  ) as SyncStoredRecord | null;
}

/**
 * The server-stored form of a client record: the wire projection, then the
 * server's own normalization. Independent of the client codec on purpose.
 */
function stored(r: SyncStoredRecord): ServerRecord {
  return server.normalizeForStore(toWireLike(r), NO_CLAMP_NOW);
}

/** The server-stored form as the real push path produces it (Req 16.3). */
function storedViaPush(r: SyncStoredRecord): ServerRecord {
  return server.normalizeForStore(
    toEventRecord(r as StoredRecord) as unknown as ServerRecord,
    NO_CLAMP_NOW,
  );
}

/** `-1 | 0 | 1` from any numeric comparison result, so the two sides compare. */
function sign(n: number): -1 | 0 | 1 {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

/** Which input was retained: 0 for the left side, 1 for the right, -1 for none. */
function chosenSide(result: unknown, a: unknown, b: unknown): number {
  if (result === null) return -1;
  if (result === a) return 0;
  if (result === b) return 1;
  return Number.NaN; // neither input — a copy or a fabricated record
}

/** A copy with no Photo, for showing the Photo is not what makes the two agree. */
function withoutPhoto(r: SyncStoredRecord): SyncStoredRecord {
  const copy = cloneRecord(r) as unknown as Record<string, unknown>;
  delete copy.photo;
  return copy as unknown as SyncStoredRecord;
}

// ---------------------------------------------------------------------------
// The shared total ordering (Req 8.3)
// ---------------------------------------------------------------------------

describe("Property 5: The client and server merge rules agree", () => {
  it("derives the same canonical key for a record and the form the server stores it in", () => {
    fc.assert(
      fc.property(arbStoredRecord, (record) => {
        // The client folds its `unknownFields` container in at the top level,
        // where the wire carries those fields; the server reads them inline
        // because that is how they are already stored. Same event, same key —
        // asserted, not assumed. A Photo on the client side is excluded by both.
        expect(server.canonicalKey(stored(record))).toBe(
          clientCanonicalKey(record as StoredRecord),
        );

        // And the same through the real push projection, which is the shape the
        // Sync_Service actually receives and stores.
        expect(server.canonicalKey(storedViaPush(record))).toBe(
          clientCanonicalKey(record as StoredRecord),
        );
      }),
      { numRuns: 400 },
    );
  });

  it("agrees on which records are tombstones (Req 8.2)", () => {
    fc.assert(
      fc.property(arbStoredRecord, (record) => {
        const isDeleted = (record as { deleted?: true }).deleted === true;
        expect(server.isTombstone(stored(record))).toBe(isDeleted);
      }),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // The ordering itself (Req 8.1, 8.2, 8.3)
  // -------------------------------------------------------------------------

  it("returns the same comparison sign for every pair sharing an id", () => {
    fc.assert(
      fc.property(arbRecordPair, ({ a, b }) => {
        const sa = stored(a);
        const sb = stored(b);

        expect(sign(server.compareForMerge(sa, sb))).toBe(clientCompare(a, b));
        // Both directions, so neither side's antisymmetry can hide a mismatch.
        expect(sign(server.compareForMerge(sb, sa))).toBe(clientCompare(b, a));
      }),
      { numRuns: 500 },
    );
  });

  it("selects the same side, and a field-for-field equal winner, for every pair", () => {
    fc.assert(
      fc.property(arbRecordPair, ({ a, b }) => {
        const sa = stored(a);
        const sb = stored(b);

        const clientWinner = clientMerge(a, b);
        const serverWinner = server.mergeRecords(sa, sb);

        // The same input is retained on both sides — not merely an equal one.
        expect(chosenSide(serverWinner, sa, sb)).toBe(chosenSide(clientWinner, a, b));
        // And the retained record carries the same fields on both sides.
        expect(serverWinner).toEqual(stored(clientWinner as SyncStoredRecord));

        // Swapping the sides changes neither side's answer (Req 8.3: which party
        // holds a record is never a factor).
        expect(server.mergeRecords(sb, sa)).toEqual(
          stored(clientMerge(b, a) as SyncStoredRecord),
        );
      }),
      { numRuns: 500 },
    );
  });

  it("agrees on every fold of three records sharing an id (Req 8.3)", () => {
    fc.assert(
      fc.property(arbRecordTriple, ({ a, b, c }) => {
        const sides = [a, b, c];
        const serverSides = sides.map(stored);

        for (const [i, j, k] of [
          [0, 1, 2],
          [1, 2, 0],
          [2, 0, 1],
        ] as const) {
          const clientFold = clientMerge(clientMerge(sides[i], sides[j]), sides[k]);
          const serverFold = server.mergeRecords(
            server.mergeRecords(serverSides[i], serverSides[j]),
            serverSides[k],
          );
          expect(serverFold).toEqual(stored(clientFold as SyncStoredRecord));
        }
      }),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // No entry on one side (Req 8.4)
  // -------------------------------------------------------------------------

  it("retains the present record unchanged on both sides when one side holds no entry", () => {
    fc.assert(
      fc.property(arbStoredRecord, (record) => {
        const s = stored(record);

        // Including when the present record is a Tombstone: absence is not a
        // deletion and carries no Revision_Time.
        expect(clientMerge(record, null)).toBe(record);
        expect(clientMerge(null, record)).toBe(record);
        expect(server.mergeRecords(s, null)).toBe(s);
        expect(server.mergeRecords(null, s)).toBe(s);
      }),
      { numRuns: 200 },
    );
  });

  it("keeps two absent sides absent on both sides", () => {
    expect(clientMerge(null, null)).toBeNull();
    expect(server.mergeRecords(null, null)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Photos are not what makes the two agree (Req 8.7, 16.1)
  // -------------------------------------------------------------------------

  it("agrees identically whether or not the client records carry photos", () => {
    fc.assert(
      fc.property(arbRecordPair, ({ a, b }) => {
        const bareA = withoutPhoto(a);
        const bareB = withoutPhoto(b);

        // The server never sees Photo bytes, so the stored form is unchanged.
        expect(stored(bareA)).toEqual(stored(a));
        expect(stored(bareB)).toEqual(stored(b));

        // And the client's own ordering is unchanged, so the agreement asserted
        // above holds for the photo-bearing and photo-free pair alike.
        expect(clientCompare(bareA, bareB)).toBe(clientCompare(a, b));
        expect(sign(server.compareForMerge(stored(a), stored(b)))).toBe(
          clientCompare(bareA, bareB),
        );
      }),
      { numRuns: 300 },
    );
  });
});
