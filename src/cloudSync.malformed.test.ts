// Feature: cloud-sync, Property 10: Malformed records are skipped, never fatal
//
// For any arbitrary value interpreted as a wire record — a missing `id`, a
// missing `createdAt`, a missing `updatedAt`, an unrecognized `type`, a
// `confidence` outside `confident|maybe`, a `severity` outside
// `mild|moderate|severe`, a `stress` outside `low|medium|high`, a `sleep`
// outside `poor|ok|good`, a `bristol` outside the integer range 1–7, a
// non-string `note`, a `deleted` flag that is present but not `true`, or a value
// that is not a record at all — `fromEventRecord` returns either `null` or a
// stored record that satisfies the domain, and never throws.
//
// Validates: Requirements 20.3, 20.4
//
// The property is asserted in the strong form: rather than checking the known
// bad shapes one at a time, it checks that *every* input lands in one of two
// buckets. That is what makes "never fatal" a property of the codec rather than
// a property of the mutation list — a throw for any input, including one no
// generator in `arbitraries.ts` produces today, fails the test.
//
// The second half asserts the page-level consequence: a page mixing valid and
// malformed records parses each entry to the same result it would parse to on
// its own, so one bad record cannot poison its neighbours (Req 20.3's "SHALL
// continue merging the remaining Event_Records").

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fromEventRecord } from "./cloudSync";
import { isTombstone, type StoredRecord } from "./db";
import {
  arbMalformedWireRecord,
  arbValidWireRecord,
  arbWireRecord,
  arbWireRecordPage,
} from "./test/arbitraries";

// ---------------------------------------------------------------------------
// The domain a returned record must satisfy (Requirement 20.1, 20.4)
// ---------------------------------------------------------------------------

const EVENT_TYPES = ["meal", "symptom", "bowel", "checkin"];
const CONFIDENCE_VALUES = ["confident", "maybe"];
const SEVERITY_VALUES = ["mild", "moderate", "severe"];
const STRESS_VALUES = ["low", "medium", "high"];
const SLEEP_VALUES = ["poor", "ok", "good"];

/** Keys a parsed record of each kind may carry — nothing else may be smuggled. */
const ALLOWED_KEYS: Record<string, readonly string[]> = {
  tombstone: ["id", "type", "createdAt", "updatedAt", "deleted", "unknownFields"],
  meal: [
    "id",
    "type",
    "createdAt",
    "updatedAt",
    "note",
    "unknownFields",
    "dish",
    "ingredients",
    "outcome",
  ],
  symptom: ["id", "type", "createdAt", "updatedAt", "note", "unknownFields", "symptoms"],
  bowel: ["id", "type", "createdAt", "updatedAt", "note", "unknownFields", "bristol", "symptoms"],
  checkin: ["id", "type", "createdAt", "updatedAt", "note", "unknownFields", "stress", "sleep"],
};

/**
 * Preserved unknown fields must be JSON-safe and Photo-free: no `Blob`, no
 * typed array, no `Date`, no key named `photo`, and no `data:` string
 * (Req 16.1, 16.4, 20.2). Anything else means the codec carried an unusable
 * value into the Local_Store.
 */
function violationsInUnknownValue(value: unknown, path: string): string[] {
  if (value === null) return [];
  switch (typeof value) {
    case "string":
      return value.startsWith("data:") ? [`${path} is a data: URL`] : [];
    case "number":
      return Number.isFinite(value) ? [] : [`${path} is not a finite number`];
    case "boolean":
      return [];
    case "object":
      break;
    default:
      return [`${path} is a ${typeof value}`];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, i) => violationsInUnknownValue(item, `${path}[${i}]`));
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== null && proto !== Object.prototype) {
    return [`${path} is not a plain object`];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    key === "photo"
      ? [`${path}.photo is present`]
      : violationsInUnknownValue(nested, `${path}.${key}`),
  );
}

function violationsInSymptoms(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [`${path} is not an array`];
  return value.flatMap((s, i) => {
    if (typeof s !== "object" || s === null) return [`${path}[${i}] is not an object`];
    const { id, severity } = s as Record<string, unknown>;
    const out: string[] = [];
    if (typeof id !== "string") out.push(`${path}[${i}].id is not a string`);
    if (typeof severity !== "string" || !SEVERITY_VALUES.includes(severity)) {
      out.push(`${path}[${i}].severity is out of domain`);
    }
    return out;
  });
}

/** Every way a parsed record could fail to be a usable stored record. */
function domainViolations(record: StoredRecord): string[] {
  const src = record as unknown as Record<string, unknown>;
  const out: string[] = [];

  if (typeof src.id !== "string" || src.id.length === 0) out.push("id is missing or empty");
  if (typeof src.type !== "string" || !EVENT_TYPES.includes(src.type)) {
    out.push("type is unrecognized");
  }
  if (!Number.isInteger(src.createdAt)) out.push("createdAt is not an integer");
  if (!Number.isInteger(src.updatedAt)) out.push("updatedAt is not an integer");
  if ("photo" in src) out.push("photo came off the wire");
  if ("note" in src && typeof src.note !== "string") out.push("note is not a string");
  if ("unknownFields" in src) {
    out.push(...violationsInUnknownValue(src.unknownFields, "unknownFields"));
    if (
      typeof src.unknownFields === "object" &&
      src.unknownFields !== null &&
      Object.keys(src.unknownFields).length === 0
    ) {
      // An empty container has no wire representation, so it is never written.
      out.push("unknownFields is present but empty");
    }
  }

  const kind = isTombstone(record) ? "tombstone" : (src.type as string);
  const allowed = ALLOWED_KEYS[kind];
  if (allowed) {
    for (const key of Object.keys(src)) {
      if (!allowed.includes(key)) out.push(`unexpected key ${key} on a ${kind}`);
    }
  }

  if (isTombstone(record)) {
    if (src.deleted !== true) out.push("deleted flag is not true");
    return out;
  }
  if ("deleted" in src) out.push("a non-tombstone carries a deleted flag");

  switch (record.type) {
    case "meal":
      if (typeof src.dish !== "string") out.push("dish is not a string");
      if (!Array.isArray(src.ingredients)) {
        out.push("ingredients is not an array");
      } else {
        for (const [i, ing] of src.ingredients.entries()) {
          if (typeof ing !== "object" || ing === null) {
            out.push(`ingredients[${i}] is not an object`);
            continue;
          }
          const { name, confidence } = ing as Record<string, unknown>;
          if (typeof name !== "string") out.push(`ingredients[${i}].name is not a string`);
          if (typeof confidence !== "string" || !CONFIDENCE_VALUES.includes(confidence)) {
            out.push(`ingredients[${i}].confidence is out of domain`);
          }
        }
      }
      // "fine" or absent. Absent must stay absent: it means "not stated", and a
      // coerced value would be a claim the user never made.
      if ("outcome" in src && src.outcome !== "fine") out.push("outcome is out of domain");
      break;
    case "symptom":
      out.push(...violationsInSymptoms(src.symptoms, "symptoms"));
      break;
    case "bowel":
      if (!Number.isInteger(src.bristol) || (src.bristol as number) < 1 || (src.bristol as number) > 7) {
        out.push("bristol is not an integer 1–7");
      }
      if ("symptoms" in src) out.push(...violationsInSymptoms(src.symptoms, "symptoms"));
      break;
    case "checkin":
      if ("stress" in src && !STRESS_VALUES.includes(src.stress as string)) {
        out.push("stress is out of domain");
      }
      if ("sleep" in src && !SLEEP_VALUES.includes(src.sleep as string)) {
        out.push("sleep is out of domain");
      }
      break;
  }

  return out;
}

/** Parse without letting a throw escape, so the failure message names the input. */
function parseSafely(raw: unknown): StoredRecord | null {
  try {
    return fromEventRecord(raw);
  } catch (err) {
    throw new Error(
      `fromEventRecord threw instead of skipping: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Either skipped, or a record satisfying the domain — never anything else. */
function expectSkippedOrValid(raw: unknown): StoredRecord | null {
  const parsed = parseSafely(raw);
  if (parsed === null) return null;
  const violations = domainViolations(parsed);
  expect(violations, `parsed record violates the domain: ${violations.join("; ")}`).toEqual([]);
  return parsed;
}

// ---------------------------------------------------------------------------
// A known field replaced by a wholly arbitrary value
//
// The mutation list in `arbitraries.ts` covers the shapes Requirement 20.4
// names. This generator covers the ones nobody thought of: any recognized key
// can hold any value at all.
// ---------------------------------------------------------------------------

const WIRE_KEYS = [
  "id",
  "type",
  "createdAt",
  "updatedAt",
  "schemaVersion",
  "deleted",
  "note",
  "dish",
  "ingredients",
  "symptoms",
  "bristol",
  "stress",
  "sleep",
] as const;

const arbArbitrarilyMutatedRecord: fc.Arbitrary<unknown> = fc
  .tuple(arbValidWireRecord, fc.constantFrom(...WIRE_KEYS), fc.anything())
  .map(([wire, key, value]) => ({ ...wire, [key]: value }));

/** Everything a pulled page could conceivably hold. */
const arbAnyWireValue: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: arbWireRecord, weight: 6 },
  { arbitrary: arbArbitrarilyMutatedRecord, weight: 3 },
  { arbitrary: fc.anything(), weight: 1 },
);

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

describe("Property 10: Malformed records are skipped, never fatal", () => {
  it("returns null or a domain-valid record for any wire value, and never throws", () => {
    fc.assert(
      fc.property(arbAnyWireValue, (raw) => {
        expectSkippedOrValid(raw);
      }),
      { numRuns: 500 },
    );
  });

  it("skips every deliberately malformed record", () => {
    fc.assert(
      fc.property(arbMalformedWireRecord, (raw) => {
        expect(expectSkippedOrValid(raw)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it("keeps every well-formed record", () => {
    fc.assert(
      fc.property(arbValidWireRecord, (raw) => {
        expect(expectSkippedOrValid(raw)).not.toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it("skips bad records in a page without disturbing the rest", () => {
    // A page of tagged entries, so the test knows which entries must survive.
    const arbTaggedEntry = fc.oneof(
      { arbitrary: arbValidWireRecord.map((wire) => ({ valid: true, wire })), weight: 3 },
      { arbitrary: arbMalformedWireRecord.map((wire) => ({ valid: false, wire })), weight: 2 },
    );

    fc.assert(
      fc.property(fc.array(arbTaggedEntry, { maxLength: 30 }), (page) => {
        const merged: StoredRecord[] = [];
        let skipped = 0;

        for (const entry of page) {
          const parsed = expectSkippedOrValid(entry.wire);
          if (parsed === null) {
            skipped++;
            expect(entry.valid).toBe(false);
          } else {
            merged.push(parsed);
            expect(entry.valid).toBe(true);
            // Neighbours cannot change the outcome: the record parses to the
            // same value it would parse to on its own.
            expect(parsed).toEqual(fromEventRecord(entry.wire));
          }
        }

        // Every entry is accounted for exactly once: merged or skipped.
        expect(merged.length + skipped).toBe(page.length);
        expect(merged.length).toBe(page.filter((e) => e.valid).length);
      }),
      { numRuns: 200 },
    );
  });

  it("parses a page of arbitrary values with no entry left unaccounted for", () => {
    fc.assert(
      fc.property(arbWireRecordPage, (page) => {
        const results = page.map((raw) => expectSkippedOrValid(raw));
        expect(results.length).toBe(page.length);
        // Parsing the page is exactly parsing each entry: no shared state, so a
        // bad record early in a page cannot change a later one (Req 20.3).
        expect(results).toEqual(page.map((raw) => fromEventRecord(raw)));
      }),
      { numRuns: 150 },
    );
  });
});
