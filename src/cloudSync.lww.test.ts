// Property 3: Last-write-wins, with tombstones winning ties.
// Property 4: Photos never influence the merge.
//
// Validates: Requirements 8.1, 8.2, 8.7, 16.6
//
// These two properties pin the *front* of the merge ordering. Property 3 asserts
// that a greater Revision_Time decides the winner on its own — no createdAt, no
// deleted flag, no content, and no photo can rescue the older revision — and
// that on an equal-Revision_Time tie the Tombstone is retained no matter which
// side holds it or which argument came first. Property 4 asserts that photos are
// outside the ordering entirely: adding, changing, or removing a photo on either
// side never changes the comparison, never changes which side wins, and leaves
// both input photos untouched (Req 16.6).
//
// The merge returns the winner *by reference*, which is what makes "which side
// won" observable: comparing against `a` or `b` by identity is a stronger check
// than field equality, since two generated sides can be field-for-field equal.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalKey, compareForMerge, mergeRecords } from "./cloudSync";
import type { StoredRecord } from "./db";
import {
  MAX_EPOCH_MS,
  arbEpochMs,
  arbLogEventWithPhoto,
  arbPhoto,
  arbRecordPair,
  arbStoredRecord,
  arbTombstone,
  cloneRecord,
  isSyncTombstone,
  type SyncStoredRecord,
} from "./test/arbitraries";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The generators build structural v3 records; the merge takes the real type. */
function rec(r: SyncStoredRecord): StoredRecord {
  return r as unknown as StoredRecord;
}

/** Which side the merge kept, by reference — `null` for two absent sides. */
function winnerSide(a: SyncStoredRecord, b: SyncStoredRecord): "a" | "b" | "neither" {
  const won = mergeRecords(rec(a), rec(b));
  if (won === rec(a)) return "a";
  if (won === rec(b)) return "b";
  return "neither";
}

/** A record's fields with any photo removed, for comparing non-photo content. */
function withoutPhoto(r: SyncStoredRecord): Record<string, unknown> {
  const copy = { ...(r as unknown as Record<string, unknown>) };
  delete copy.photo;
  return copy;
}

function photoOf(r: SyncStoredRecord): Blob | undefined {
  return (r as { photo?: Blob }).photo;
}

/** Two epoch values that are genuinely different, so Req 8.1 applies. */
const arbTwoDistinctEpochs: fc.Arbitrary<[number, number]> = fc
  .tuple(arbEpochMs, arbEpochMs)
  .filter(([x, y]) => x !== y);

// ---------------------------------------------------------------------------
// Property 3 generators
// ---------------------------------------------------------------------------

interface RevisionPair {
  /** The lesser Revision_Time. */
  older: SyncStoredRecord;
  /** The greater Revision_Time — the record Requirement 8.1 retains. */
  newer: SyncStoredRecord;
  /** Whether `newer` was the left-hand side when the pair was built. */
  newerBuiltFirst: boolean;
}

/**
 * Two records sharing an `id` whose Revision_Times differ. Every other field is
 * drawn independently — content, `createdAt`, the deleted flag, preserved
 * unknown fields, and photos all vary freely on both sides — so the property is
 * a claim about `updatedAt` alone (Req 8.1).
 */
const arbDistinctRevisionPair: fc.Arbitrary<RevisionPair> = fc
  .tuple(arbStoredRecord, arbStoredRecord, arbTwoDistinctEpochs, fc.boolean())
  .map(([left, right, [u1, u2], newerBuiltFirst]) => {
    const a = cloneRecord(left);
    const b = cloneRecord(right) as SyncStoredRecord & { id: string };
    b.id = a.id;
    const lo = Math.min(u1, u2);
    const hi = Math.max(u1, u2);
    a.updatedAt = newerBuiltFirst ? hi : lo;
    b.updatedAt = newerBuiltFirst ? lo : hi;
    return newerBuiltFirst
      ? { older: b, newer: a, newerBuiltFirst }
      : { older: a, newer: b, newerBuiltFirst };
  });

/** How the two sides' `createdAt` values relate in a Revision_Time tie. */
type CreatedAtBias = "free" | "event-newer" | "tombstone-newer";

interface TiedTombstonePair {
  event: SyncStoredRecord;
  tombstone: SyncStoredRecord;
  bias: CreatedAtBias;
}

/**
 * An event and a Tombstone sharing an `id` and an equal Revision_Time — the
 * exact shape of Requirement 8.2. `bias` decides whether the event holds the
 * greater `createdAt`, so the case where the *later* tiebreak key favours the
 * event is always reachable: the Tombstone must still win.
 */
const arbTiedTombstonePair: fc.Arbitrary<TiedTombstonePair> = fc
  .tuple(
    arbLogEventWithPhoto,
    arbTombstone,
    arbEpochMs,
    fc.constantFrom<CreatedAtBias>("free", "free", "event-newer", "tombstone-newer"),
  )
  .map(([rawEvent, rawTombstone, updatedAt, bias]) => {
    const event = cloneRecord(rawEvent) as SyncStoredRecord & { createdAt: number };
    const tombstone = cloneRecord(rawTombstone) as SyncStoredRecord & {
      id: string;
      createdAt: number;
    };
    tombstone.id = event.id;
    event.updatedAt = updatedAt;
    tombstone.updatedAt = updatedAt;
    if (bias === "event-newer") {
      event.createdAt = MAX_EPOCH_MS;
      tombstone.createdAt = 0;
    } else if (bias === "tombstone-newer") {
      event.createdAt = 0;
      tombstone.createdAt = MAX_EPOCH_MS;
    }
    return { event, tombstone, bias };
  });

// ---------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------

describe("Property 3: Last-write-wins, with tombstones winning ties", () => {
  it("retains the greater Revision_Time in either argument order (Req 8.1)", () => {
    fc.assert(
      fc.property(arbDistinctRevisionPair, ({ older, newer }) => {
        expect(newer.updatedAt).toBeGreaterThan(older.updatedAt);

        expect(mergeRecords(rec(older), rec(newer))).toBe(rec(newer));
        expect(mergeRecords(rec(newer), rec(older))).toBe(rec(newer));
        expect(compareForMerge(rec(older), rec(newer))).toBe(-1);
        expect(compareForMerge(rec(newer), rec(older))).toBe(1);
      }),
      { numRuns: 400 },
    );
  });

  it("considers no field other than Revision_Time once the two differ (Req 8.1)", () => {
    fc.assert(
      fc.property(arbDistinctRevisionPair, arbPhoto, ({ older, newer }, photo) => {
        // Stack every later tiebreak key in the older side's favour: make it a
        // Tombstone (key 2), give it the maximum `createdAt` (key 3), and hand
        // it a preserved field that pushes its canonical key around (key 4).
        const stacked = cloneRecord(older) as unknown as Record<string, unknown>;
        stacked.deleted = true;
        stacked.createdAt = MAX_EPOCH_MS;
        stacked.unknownFields = { zzz_last: "\uffff".repeat(8) };
        stacked.photo = photo;
        const loaded = stacked as unknown as SyncStoredRecord;

        // ...and strip the newer side down to the weakest content we can give
        // it, so nothing but `updatedAt` is carrying its win.
        const bare = cloneRecord(newer) as unknown as Record<string, unknown>;
        bare.createdAt = 0;
        delete bare.unknownFields;
        delete bare.photo;
        const thin = bare as unknown as SyncStoredRecord;

        expect(isSyncTombstone(loaded)).toBe(true);
        expect(mergeRecords(rec(loaded), rec(thin))).toBe(rec(thin));
        expect(mergeRecords(rec(thin), rec(loaded))).toBe(rec(thin));
      }),
      { numRuns: 300 },
    );
  });

  it("retains the tombstone on a Revision_Time tie, either side, either order (Req 8.2)", () => {
    fc.assert(
      fc.property(arbTiedTombstonePair, ({ event, tombstone }) => {
        expect(event.updatedAt).toBe(tombstone.updatedAt);
        expect(isSyncTombstone(tombstone)).toBe(true);
        expect(isSyncTombstone(event)).toBe(false);

        // "regardless of which party holds the Tombstone and regardless of
        // which Event_Record was evaluated first" — both argument orders.
        expect(mergeRecords(rec(event), rec(tombstone))).toBe(rec(tombstone));
        expect(mergeRecords(rec(tombstone), rec(event))).toBe(rec(tombstone));
        expect(compareForMerge(rec(tombstone), rec(event))).toBe(1);
        expect(compareForMerge(rec(event), rec(tombstone))).toBe(-1);
      }),
      { numRuns: 400 },
    );
  });

  it("lets the tombstone win a tie even when the event has the greater createdAt (Req 8.2)", () => {
    fc.assert(
      fc.property(
        arbTiedTombstonePair.filter(({ bias }) => bias === "event-newer"),
        ({ event, tombstone }) => {
          expect(event.createdAt).toBeGreaterThan(tombstone.createdAt);
          expect(mergeRecords(rec(event), rec(tombstone))).toBe(rec(tombstone));
          expect(mergeRecords(rec(tombstone), rec(event))).toBe(rec(tombstone));
        },
      ),
      { numRuns: 150 },
    );
  });

  it("holds over the shared pair generator's tie modes (Req 8.1, 8.2)", () => {
    fc.assert(
      fc.property(arbRecordPair, ({ a, b }) => {
        if (a.updatedAt !== b.updatedAt) {
          const newer = a.updatedAt > b.updatedAt ? a : b;
          expect(mergeRecords(rec(a), rec(b))).toBe(rec(newer));
          expect(mergeRecords(rec(b), rec(a))).toBe(rec(newer));
          return;
        }
        const aDeleted = isSyncTombstone(a);
        const bDeleted = isSyncTombstone(b);
        if (aDeleted === bDeleted) return; // not the Req 8.2 case
        const tombstone = aDeleted ? a : b;
        expect(mergeRecords(rec(a), rec(b))).toBe(rec(tombstone));
        expect(mergeRecords(rec(b), rec(a))).toBe(rec(tombstone));
      }),
      { numRuns: 400 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 generators
// ---------------------------------------------------------------------------

/** Absent, one of two distinct photos, or a zero-byte photo. */
type PhotoSlot = "absent" | "first" | "second" | "empty";

const arbPhotoSlot: fc.Arbitrary<PhotoSlot> = fc.constantFrom<PhotoSlot>(
  "absent",
  "first",
  "second",
  "empty",
);

interface PhotoAssignment {
  left: PhotoSlot;
  right: PhotoSlot;
  first: Blob;
  second: Blob;
}

const arbPhotoAssignment: fc.Arbitrary<PhotoAssignment> = fc
  .record({
    left: arbPhotoSlot,
    right: arbPhotoSlot,
    first: arbPhoto,
    second: arbPhoto,
  })
  .filter(({ left, right }) => left !== "absent" || right !== "absent");

/** A copy of `r` carrying exactly the photo the slot names. */
function assignPhoto(
  r: SyncStoredRecord,
  slot: PhotoSlot,
  assignment: PhotoAssignment,
): SyncStoredRecord {
  const copy = cloneRecord(r) as unknown as Record<string, unknown>;
  delete copy.photo;
  if (slot === "first") copy.photo = assignment.first;
  else if (slot === "second") copy.photo = assignment.second;
  else if (slot === "empty") copy.photo = new Blob([]);
  return copy as unknown as SyncStoredRecord;
}

/** A copy of `r` with no photo at all — the Property 4 baseline. */
function stripPhoto(r: SyncStoredRecord): SyncStoredRecord {
  return assignPhoto(r, "absent", {
    left: "absent",
    right: "absent",
    first: new Blob([]),
    second: new Blob([]),
  });
}

// ---------------------------------------------------------------------------
// Property 4
// ---------------------------------------------------------------------------

describe("Property 4: Photos never influence the merge", () => {
  it("compareForMerge is unchanged by any photo assignment (Req 8.7)", () => {
    fc.assert(
      fc.property(arbRecordPair, arbPhotoAssignment, ({ a, b }, assignment) => {
        const baseA = stripPhoto(a);
        const baseB = stripPhoto(b);
        const withA = assignPhoto(a, assignment.left, assignment);
        const withB = assignPhoto(b, assignment.right, assignment);

        const baseline = compareForMerge(rec(baseA), rec(baseB));
        expect(compareForMerge(rec(withA), rec(withB))).toBe(baseline);
        // Symmetric direction too, so a photo cannot flip the ordering only one
        // way round.
        expect(compareForMerge(rec(withB), rec(withA))).toBe(
          compareForMerge(rec(baseB), rec(baseA)),
        );
        // The tiebreak key itself is photo-blind, which is what makes the
        // client and the Sync_Service able to agree on it.
        expect(canonicalKey(rec(withA))).toBe(canonicalKey(rec(baseA)));
        expect(canonicalKey(rec(withB))).toBe(canonicalKey(rec(baseB)));
      }),
      { numRuns: 400 },
    );
  });

  it("selects the same side and the same non-photo fields (Req 8.7, 16.6)", () => {
    fc.assert(
      fc.property(arbRecordPair, arbPhotoAssignment, ({ a, b }, assignment) => {
        const baseA = stripPhoto(a);
        const baseB = stripPhoto(b);
        const withA = assignPhoto(a, assignment.left, assignment);
        const withB = assignPhoto(b, assignment.right, assignment);

        const baselineSide = winnerSide(baseA, baseB);
        expect(winnerSide(withA, withB)).toBe(baselineSide);
        // Adding, changing, or removing a photo cannot change the winner's
        // event data either.
        const baselineWinner = mergeRecords(rec(baseA), rec(baseB));
        const photoWinner = mergeRecords(rec(withA), rec(withB));
        expect(withoutPhoto(photoWinner as unknown as SyncStoredRecord)).toEqual(
          withoutPhoto(baselineWinner as unknown as SyncStoredRecord),
        );
      }),
      { numRuns: 400 },
    );
  });

  it("gives the same winner whichever side holds the photo (Req 16.6)", () => {
    fc.assert(
      fc.property(arbRecordPair, arbPhoto, ({ a, b }, photo) => {
        const baselineSide = winnerSide(stripPhoto(a), stripPhoto(b));

        // Only the left side holds a photo, then only the right, then both.
        const leftOnly = winnerSide(
          assignPhoto(a, "first", { left: "first", right: "absent", first: photo, second: photo }),
          stripPhoto(b),
        );
        const rightOnly = winnerSide(
          stripPhoto(a),
          assignPhoto(b, "first", { left: "absent", right: "first", first: photo, second: photo }),
        );
        const both = winnerSide(
          assignPhoto(a, "first", { left: "first", right: "first", first: photo, second: photo }),
          assignPhoto(b, "first", { left: "first", right: "first", first: photo, second: photo }),
        );

        expect(leftOnly).toBe(baselineSide);
        expect(rightOnly).toBe(baselineSide);
        expect(both).toBe(baselineSide);
      }),
      { numRuns: 300 },
    );
  });

  it("leaves both input photos byte-for-byte unchanged (Req 16.6)", () => {
    fc.assert(
      fc.property(arbRecordPair, arbPhotoAssignment, ({ a, b }, assignment) => {
        const withA = assignPhoto(a, assignment.left, assignment);
        const withB = assignPhoto(b, assignment.right, assignment);
        const before = [photoOf(withA), photoOf(withB)] as const;
        const sizes = before.map((p) => p?.size);
        const types = before.map((p) => p?.type);

        mergeRecords(rec(withA), rec(withB));
        mergeRecords(rec(withB), rec(withA));

        // jsdom's Blob has no `arrayBuffer()`, so identity plus size and type is
        // as close to byte-for-byte as this environment gets.
        expect(photoOf(withA)).toBe(before[0]);
        expect(photoOf(withB)).toBe(before[1]);
        expect([photoOf(withA)?.size, photoOf(withB)?.size]).toEqual(sizes);
        expect([photoOf(withA)?.type, photoOf(withB)?.type]).toEqual(types);
      }),
      { numRuns: 300 },
    );
  });
});
