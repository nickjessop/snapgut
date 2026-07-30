// Feature: cloud-sync, Properties 6 and 7 (round-trip fidelity).
//
// Properties 8 (photo exclusion) and 9 (tombstone round-trip) join this file in
// tasks 6.3 and 6.4.
//
// Both properties drive the real codec from `src/cloudSync.ts`. The generators
// in `src/test/arbitraries.ts` supply inputs only — `toWireLike` there is a
// test-input projection, not a reference implementation, so nothing here
// asserts the codec against it.
//
// Two documented normalizations apply when whole records are compared:
//
// - **`photo`** is on-device only and never travels (Req 16.1), so it is
//   stripped from the expectation. Property 8 owns the claim that no photo
//   bytes reach the wire.
// - **An empty `unknownFields`** container round-trips as *absent*. The wire
//   carries preserved fields inline at the top level with no container key, so
//   "no preserved fields" has exactly one wire representation and cannot come
//   back as an empty object. Requirement 20.6's presence/absence rule names
//   `note`, `stress`, `sleep`, and `symptoms`; `unknownFields` is a local
//   container, not a Log_Event field.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fromEventRecord, toEventRecord } from "./cloudSync";
import type { Ingredient, LoggedSymptom, LogEvent, StoredRecord } from "./db";
import { arbLogEvent, arbLogEventWithPhoto, type SyncLogEvent } from "./test/arbitraries";

/** The comparison shape: no `photo`, and an empty `unknownFields` dropped. */
function normalize(r: StoredRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(r as unknown as Record<string, unknown>) };
  delete out.photo;
  const unknown = out.unknownFields as Record<string, unknown> | undefined;
  if (unknown && Object.keys(unknown).length === 0) delete out.unknownFields;
  return out;
}

/** Serialize, transit as JSON the way a push/pull does, then deserialize. */
function roundTrip(e: SyncLogEvent): StoredRecord | null {
  const wire = toEventRecord(e as LogEvent);
  return fromEventRecord(JSON.parse(JSON.stringify(wire)) as unknown);
}

/** Code points, so text equality is asserted per code point (Req 20.7). */
function codePoints(s: string): string[] {
  return Array.from(s);
}

function ingredientsOf(r: unknown): Ingredient[] | undefined {
  return (r as { ingredients?: Ingredient[] }).ingredients;
}

function symptomsOf(r: unknown): LoggedSymptom[] | undefined {
  return (r as { symptoms?: LoggedSymptom[] }).symptoms;
}

// ---------------------------------------------------------------------------
// Feature: cloud-sync, Property 6: Round-trip preserves every non-photo field
//
// For any LogEvent drawn from the Requirement 20.1 generation domain,
// fromEventRecord(toEventRecord(e)) reproduces every non-photo field equal to
// the original and preserves the element order of `ingredients` and `symptoms`.
//
// **Validates: Requirements 20.1**
// ---------------------------------------------------------------------------

describe("Property 6: Round-trip preserves every non-photo field", () => {
  it("reproduces every non-photo field of any generated LogEvent", () => {
    fc.assert(
      fc.property(arbLogEvent, (e: SyncLogEvent) => {
        const back = roundTrip(e);
        expect(back).not.toBeNull();
        expect(normalize(back!)).toEqual(normalize(e as StoredRecord));
      }),
      { numRuns: 300 },
    );
  });

  it("keeps ingredients and symptoms in their original positions", () => {
    fc.assert(
      fc.property(arbLogEvent, (e: SyncLogEvent) => {
        const back = roundTrip(e);
        expect(back).not.toBeNull();

        const before = ingredientsOf(e);
        const after = ingredientsOf(back!);
        if (before === undefined) {
          expect(after).toBeUndefined();
        } else {
          // Position by position, so a reordering cannot hide behind set equality.
          expect(after).toHaveLength(before.length);
          before.forEach((ingredient, i) => {
            expect(after![i].name).toBe(ingredient.name);
            expect(after![i].confidence).toBe(ingredient.confidence);
          });
        }

        const symptomsBefore = symptomsOf(e);
        const symptomsAfter = symptomsOf(back!);
        if (symptomsBefore === undefined) {
          expect(symptomsAfter).toBeUndefined();
        } else {
          expect(symptomsAfter).toHaveLength(symptomsBefore.length);
          symptomsBefore.forEach((symptom, i) => {
            expect(symptomsAfter![i].id).toBe(symptom.id);
            expect(symptomsAfter![i].severity).toBe(symptom.severity);
          });
        }
      }),
      { numRuns: 300 },
    );
  });

  it("preserves the non-photo fields of an event that carries a photo", () => {
    fc.assert(
      fc.property(arbLogEventWithPhoto, (e: SyncLogEvent) => {
        const back = roundTrip(e);
        expect(back).not.toBeNull();
        // A photo on the source never perturbs anything else on the record.
        expect(normalize(back!)).toEqual(normalize(e as StoredRecord));
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: cloud-sync, Property 7: Round-trip preserves absence, emptiness, and
// exact text
//
// Each of `note`, `stress`, `sleep`, and `symptoms` is present after a round
// trip if and only if it was present before — an absent field never becomes an
// empty string or empty array, and an empty value never becomes absent. Every
// text field is reproduced code point for code point; `createdAt`, `updatedAt`,
// and `bristol` come back as exactly equal integers.
//
// **Validates: Requirements 20.6, 20.7**
// ---------------------------------------------------------------------------

/** The Requirement 20.6 fields: optional, and each with a meaningful empty value. */
const PRESENCE_FIELDS = ["note", "stress", "sleep", "symptoms"] as const;

describe("Property 7: Round-trip preserves absence, emptiness, and exact text", () => {
  it("preserves presence and absence of note, stress, sleep, and symptoms", () => {
    fc.assert(
      fc.property(arbLogEvent, (e: SyncLogEvent) => {
        const back = roundTrip(e);
        expect(back).not.toBeNull();
        const source = e as unknown as Record<string, unknown>;
        const result = back as unknown as Record<string, unknown>;

        for (const field of PRESENCE_FIELDS) {
          expect(field in result).toBe(field in source);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("keeps an empty string empty and an empty collection empty", () => {
    fc.assert(
      fc.property(arbLogEvent, (e: SyncLogEvent) => {
        const back = roundTrip(e);
        expect(back).not.toBeNull();
        const source = e as unknown as Record<string, unknown>;
        const result = back as unknown as Record<string, unknown>;

        // An empty value stays that empty value rather than being dropped, and
        // a populated one stays populated — emptiness is never invented.
        if (source.note === "") expect(result.note).toBe("");
        if (typeof source.dish === "string") expect(result.dish).toBe(source.dish);
        for (const field of ["ingredients", "symptoms"] as const) {
          const before = source[field];
          if (Array.isArray(before)) {
            expect(Array.isArray(result[field])).toBe(true);
            expect((result[field] as unknown[]).length).toBe(before.length);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("reproduces every text field code point for code point", () => {
    fc.assert(
      fc.property(arbLogEvent, (e: SyncLogEvent) => {
        const back = roundTrip(e);
        expect(back).not.toBeNull();
        const source = e as unknown as Record<string, unknown>;
        const result = back as unknown as Record<string, unknown>;

        for (const field of ["dish", "note"] as const) {
          const before = source[field];
          if (typeof before === "string") {
            // Commas, quotes, newlines, surrounding whitespace, and non-BMP
            // characters all survive untouched (Req 20.7).
            expect(codePoints(result[field] as string)).toEqual(codePoints(before));
          }
        }

        for (const [i, ingredient] of (ingredientsOf(e) ?? []).entries()) {
          expect(codePoints(ingredientsOf(back!)![i].name)).toEqual(codePoints(ingredient.name));
        }

        for (const [i, symptom] of (symptomsOf(e) ?? []).entries()) {
          expect(symptomsOf(back!)![i].id).toBe(symptom.id);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("reproduces createdAt, updatedAt, and bristol as exactly equal integers", () => {
    fc.assert(
      fc.property(arbLogEvent, (e: SyncLogEvent) => {
        const back = roundTrip(e);
        expect(back).not.toBeNull();

        expect(Number.isInteger(back!.createdAt)).toBe(true);
        expect(Number.isInteger(back!.updatedAt)).toBe(true);
        // `toBe` is Object.is: no rounding, truncation, or reformatting.
        expect(back!.createdAt).toBe(e.createdAt);
        expect(back!.updatedAt).toBe(e.updatedAt);

        if (e.type === "bowel") {
          const bristol = (back as { bristol?: number }).bristol;
          expect(Number.isInteger(bristol)).toBe(true);
          expect(bristol).toBe(e.bristol);
        }
      }),
      { numRuns: 300 },
    );
  });
});
