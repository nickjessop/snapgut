// Property 1: The merge rule is total, deterministic, and idempotent.
// Property 2: The merge rule is commutative and associative.
//
// Validates: Requirements 8.3, 8.4, 8.5, 8.6
//
// These are the algebraic properties of `mergeRecords` — the ones that make the
// same set of revisions for an `id` converge to the same record on every device
// and on the Sync_Service, no matter what order the revisions arrive in or how
// they get paired up.
//
// `null` on either side means "no entry on this side" (Req 8.4): not a record
// carrying revision 0, and not a deletion. It is part of the input domain here,
// so totality covers the absent cases too.
//
// **Equality is asserted over the fields the merge rule can see.** Two records
// can compare equal (`compareForMerge` → 0) and still differ in Photo bytes,
// which the rule must not consider (Req 8.7), and in the local-only shape of
// the preserved-unknown container (`unknownFields: {}` versus the key being
// absent — the wire has no container key, so both are the same record on the
// wire). So "field-for-field equal" is checked against `toEventRecord(...)`,
// the wire projection: every non-Photo field, with preserved fields folded in
// where the wire carries them.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareForMerge, mergeRecords, toEventRecord } from "./cloudSync";
import type { StoredRecord } from "./db";
import {
  arbRecordPair,
  arbRecordTriple,
  arbStoredRecord,
  cloneRecord,
  type SyncStoredRecord,
} from "./test/arbitraries";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One side of a merge: a record, or no entry at all (Req 8.4). */
type Side = SyncStoredRecord | null;

function merge(a: Side, b: Side): StoredRecord | null {
  return mergeRecords(a as StoredRecord | null, b as StoredRecord | null);
}

function compare(a: SyncStoredRecord, b: SyncStoredRecord): -1 | 0 | 1 {
  return compareForMerge(a as StoredRecord, b as StoredRecord);
}

/**
 * The comparable projection of a merge result: `null` stays `null`, a record
 * becomes its wire form. Deep-equality over this is "every field equal" in the
 * sense Requirements 8.5 and 8.6 mean it — Photo data excluded (Req 8.7).
 */
function wire(r: StoredRecord | null): unknown {
  return r === null ? null : toEventRecord(r);
}

/** Which input was retained: 0 for the left side, 1 for the right, -1 for none. */
function chosenSide(result: StoredRecord | null, a: Side, b: Side): number {
  if (result === null) return -1;
  if (result === (a as unknown)) return 0;
  if (result === (b as unknown)) return 1;
  return Number.NaN; // neither input — a copy or a fabricated record
}

/** A pair sharing an `id`, with each side independently present or absent. */
const arbMaybePair: fc.Arbitrary<{ a: Side; b: Side }> = fc
  .tuple(
    arbRecordPair,
    fc.constantFrom<"both" | "a-only" | "b-only" | "neither">(
      "both",
      "both",
      "both",
      "a-only",
      "b-only",
      "neither",
    ),
  )
  .map(([pair, presence]) => ({
    a: presence === "both" || presence === "a-only" ? pair.a : null,
    b: presence === "both" || presence === "b-only" ? pair.b : null,
  }));

/** A triple sharing an `id`, with each side independently present or absent. */
const arbMaybeTriple: fc.Arbitrary<{ a: Side; b: Side; c: Side }> = fc
  .tuple(arbRecordTriple, fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }))
  .map(([triple, keep]) => ({
    // Each side is dropped independently, so every presence combination —
    // including all three absent — is in the domain.
    a: keep[0] ? triple.a : null,
    b: keep[1] ? triple.b : null,
    c: keep[2] ? triple.c : null,
  }));

/** Every fold order over three sides, as index permutations. */
const PERMUTATIONS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

// ---------------------------------------------------------------------------
// Property 1: total, deterministic, idempotent
// ---------------------------------------------------------------------------

describe("Property 1: The merge rule is total, deterministic, and idempotent", () => {
  it("returns exactly one of the two sides for every pair, without throwing", () => {
    fc.assert(
      fc.property(arbMaybePair, ({ a, b }) => {
        let result: StoredRecord | null = null;
        expect(() => {
          result = merge(a, b);
        }).not.toThrow();

        // Total: a defined outcome for every input, including absent sides.
        if (a === null && b === null) {
          // Two absent sides stay absent — not a fabricated empty record.
          expect(result).toBeNull();
        } else {
          expect(result).not.toBeNull();
          // The retained record is one of the inputs, by reference: "every
          // field unchanged" covers the Photo the Local_Store already holds
          // (Req 8.4).
          expect(chosenSide(result, a, b)).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("retains the present side unchanged when the other side holds no entry (Req 8.4)", () => {
    fc.assert(
      fc.property(arbStoredRecord, (record) => {
        const before = wire(record as StoredRecord);

        // Including when the present record is a Tombstone: absence is not a
        // deletion, and a tombstone is not outranked by it.
        expect(merge(record, null)).toBe(record);
        expect(merge(null, record)).toBe(record);
        // The absent side contributed no Revision_Time and no deleted flag.
        expect(wire(record as StoredRecord)).toEqual(before);
      }),
      { numRuns: 300 },
    );
  });

  it("returns a field-for-field equal result on every repeated evaluation (Req 8.5)", () => {
    fc.assert(
      fc.property(arbMaybePair, ({ a, b }) => {
        const first = merge(a, b);
        const second = merge(a, b);
        const third = merge(a, b);

        expect(second).toBe(first);
        expect(third).toBe(first);
        expect(wire(second)).toEqual(wire(first));
      }),
      { numRuns: 300 },
    );
  });

  it("selects the same side for equal inputs, so the choice is a function of field values", () => {
    fc.assert(
      fc.property(arbMaybePair, ({ a, b }) => {
        const original = merge(a, b);

        // Fresh objects carrying the same field values must resolve the same
        // way: no dependence on object identity, insertion order, or any state
        // carried between calls.
        const a2 = a === null ? null : cloneRecord(a);
        const b2 = b === null ? null : cloneRecord(b);
        const repeated = merge(a2, b2);

        expect(chosenSide(repeated, a2, b2)).toBe(chosenSide(original, a, b));
        expect(wire(repeated)).toEqual(wire(original));
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent: mergeRecords(x, x) === x, and a field-equal copy changes nothing", () => {
    fc.assert(
      fc.property(arbStoredRecord, (record) => {
        expect(merge(record, record)).toBe(record);

        // A copy holding the same field values compares equal, so the left side
        // is retained — which is what makes a re-merge of already-merged data a
        // no-op (Req 8.5).
        const copy = cloneRecord(record);
        expect(compare(record, copy)).toBe(0);
        expect(merge(record, copy)).toBe(record);
        expect(merge(copy, record)).toBe(copy);
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent on an absent side: merging no entry with no entry stays absent", () => {
    expect(merge(null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property 2: commutative and associative
// ---------------------------------------------------------------------------

describe("Property 2: The merge rule is commutative and associative", () => {
  it("is commutative: merging two sides in either order retains an equal record (Req 8.6)", () => {
    fc.assert(
      fc.property(arbMaybePair, ({ a, b }) => {
        expect(wire(merge(a, b))).toEqual(wire(merge(b, a)));
      }),
      { numRuns: 500 },
    );
  });

  it("orders a pair antisymmetrically, so which side holds a record is never a factor (Req 8.3)", () => {
    fc.assert(
      fc.property(arbRecordPair, ({ a, b }) => {
        // The mechanism behind commutativity: the ordering depends on field
        // values only, so swapping the sides flips the sign and nothing else.
        // Written as a sum because the results are exactly -1 | 0 | 1, and
        // `-0 === 0` while `Object.is(-0, 0)` is false.
        expect(compare(a, b) + compare(b, a)).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  it("is associative: either grouping of three sides retains an equal record (Req 8.6)", () => {
    fc.assert(
      fc.property(arbMaybeTriple, ({ a, b, c }) => {
        const left = merge(merge(a, b) as Side, c);
        const right = merge(a, merge(b, c) as Side);

        expect(wire(left)).toEqual(wire(right));
      }),
      { numRuns: 500 },
    );
  });

  it("retains an equal record under every fold order of three sides (Req 8.6)", () => {
    fc.assert(
      fc.property(arbMaybeTriple, ({ a, b, c }) => {
        const sides: Side[] = [a, b, c];
        const expected = wire(merge(merge(a, b) as Side, c));

        for (const [i, j, k] of PERMUTATIONS) {
          const folded = merge(merge(sides[i], sides[j]) as Side, sides[k]);
          expect(wire(folded)).toEqual(expected);
        }
      }),
      { numRuns: 300 },
    );
  });
});
