// Property 8: No photo data ever reaches the wire.
//
// Validates: Requirements 16.1, 20.2
//
// The codec's photo exclusion is structural — `photo` is never read, fields are
// copied by name, and preserved `unknownFields` go through an allowlisting deep
// clean. This suite asserts the strong form of that claim: over records whose
// meals carry photo Blobs and whose `unknownFields` are deliberately hostile
// (Blobs, typed arrays, `ArrayBuffer`s, data URLs, oversized base64 runs,
// nested `photo` keys, `Date`s, class instances, functions, non-finite numbers,
// and cycles), the wire record carries no `photo` key at any depth, no binary
// value anywhere, and serializes without a single `data:`-prefixed string.
//
// It also asserts the second half of Requirement 16.1: serializing leaves the
// Photo held in the Local_Store byte-for-byte unchanged.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { serializeForPush, toEventRecord, type EventRecord } from "./cloudSync";
import type { StoredRecord } from "./db";
import {
  arbPhoto,
  arbStoredRecord,
  arbLogEventWithPhoto,
  type SyncStoredRecord,
} from "./test/arbitraries";

// ---------------------------------------------------------------------------
// Adversarial unknown fields
//
// `arbUnknownFields` in the shared module is JSON-safe by construction, which
// is the wrong input for this property. These generators carry exactly the
// things that must never survive to the wire.
// ---------------------------------------------------------------------------

/** A base64 run past the Requirement 16.2 ceiling of 4,096 characters. */
const arbLongBase64: fc.Arbitrary<string> = fc
  .integer({ min: 4_097, max: 6_000 })
  .map((n) => "QUJDREVG".repeat(Math.ceil(n / 8)).slice(0, n));

/** A data URL, the other Requirement 16.2 shape. */
const arbDataUrl: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 1, maxLength: 48 })
  .map((bytes) => `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`);

class Photoish {
  constructor(readonly bytes: Uint8Array) {}
}

/** Values that must never reach the wire, in every shape we can think of. */
const arbPhotoBearingValue: fc.Arbitrary<unknown> = fc.oneof(
  arbPhoto,
  arbDataUrl,
  arbLongBase64,
  fc.uint8Array({ minLength: 1, maxLength: 32 }),
  fc.uint8Array({ minLength: 1, maxLength: 32 }).map((b) => Uint8Array.from(b).buffer),
  fc.uint8Array({ minLength: 1, maxLength: 32 }).map((b) => new DataView(Uint8Array.from(b).buffer)),
  fc.uint8Array({ minLength: 1, maxLength: 32 }).map((b) => new Photoish(Uint8Array.from(b))),
  arbPhoto.map((photo) => ({ photo })),
  arbDataUrl.map((url) => ({ thumbnail: { small: url } })),
  arbPhoto.map((photo) => [{ attachments: [photo] }]),
  fc.constant(null).map(() => new Date(1_700_000_000_000)),
  fc.constant(null).map(() => () => "photo"),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  // A cycle: no depth of copying can reproduce it, so the key must be dropped.
  fc.constant(null).map(() => {
    const cyclic: Record<string, unknown> = { label: "loop" };
    cyclic.self = cyclic;
    return cyclic;
  }),
);

/** Benign values, so the hostile ones are not the only thing exercised. */
const arbBenignValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
  fc.record({ nested: fc.string({ maxLength: 8 }) }),
  // Short base64 text stays under the 4,096-character ceiling, so it is
  // ordinary data rather than Photo data (Req 16.2).
  fc.constant("QUJDREVG"),
);

const arbHostileKey: fc.Arbitrary<string> = fc.constantFrom(
  "photo",
  "photoData",
  "thumb",
  "attachment",
  "x_extra",
  "futureField",
  "vendor:tag",
  "mood",
);

/** `unknownFields` a newer schema might hand us, hostile values included. */
const arbAdversarialUnknownFields: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  arbHostileKey,
  fc.oneof(
    { arbitrary: arbPhotoBearingValue, weight: 3 },
    { arbitrary: arbBenignValue, weight: 2 },
  ),
  { minKeys: 1, maxKeys: 5 },
);

/**
 * Stored records aimed at this property: every meal carries a photo, and most
 * records carry hostile preserved fields. Tombstones and photo-free events stay
 * in the mix through `arbStoredRecord`, since a tombstone's preserved fields
 * take the same path.
 */
const arbPhotoHostileRecord: fc.Arbitrary<SyncStoredRecord> = fc
  .tuple(
    fc.oneof(
      { arbitrary: arbLogEventWithPhoto, weight: 3 },
      { arbitrary: arbStoredRecord, weight: 1 },
    ),
    fc.option(arbAdversarialUnknownFields, { nil: undefined, freq: 5 }),
    arbPhoto,
  )
  .map(([record, unknownFields, photo]) => {
    const out = { ...record } as Record<string, unknown>;
    if (unknownFields !== undefined) out.unknownFields = unknownFields;
    // Guarantee a photo on every meal, so the meal path is always covered.
    if (out.type === "meal" && out.deleted !== true) out.photo ??= photo;
    return out as unknown as SyncStoredRecord;
  });

// ---------------------------------------------------------------------------
// Leak detection
// ---------------------------------------------------------------------------

const BASE64_ONLY = /^[A-Za-z0-9+/=\r\n]+$/;
const MAX_BASE64_FREE_LENGTH = 4_096;

/** Anything that is, or could hold, raw bytes. */
function isBinaryLike(value: object): boolean {
  return (
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    value instanceof DataView ||
    ArrayBuffer.isView(value)
  );
}

/** A `{}` literal, as opposed to a Date, a Blob, or a class instance. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  if (proto === null || proto === Object.prototype) return true;
  return proto.constructor?.name === "Object";
}

/**
 * Every reason a wire record would count as carrying Photo data, reported as a
 * path so a counterexample says where the leak is.
 */
function findPhotoLeaks(record: EventRecord): string[] {
  const leaks: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "function") {
      leaks.push(`${path}: function`);
      return;
    }
    if (typeof value === "string") {
      if (value.startsWith("data:")) leaks.push(`${path}: data: URL`);
      else if (value.length > MAX_BASE64_FREE_LENGTH && BASE64_ONLY.test(value)) {
        leaks.push(`${path}: ${value.length}-char base64 run`);
      }
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (seen.has(value)) {
      leaks.push(`${path}: cycle`);
      return;
    }
    seen.add(value);

    if (isBinaryLike(value)) {
      leaks.push(`${path}: ${value.constructor.name}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (!isPlainObject(value)) {
      leaks.push(`${path}: ${value.constructor?.name ?? "non-plain object"} instance`);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === "photo") leaks.push(`${path}.photo: photo-named key`);
      walk(nested, `${path}.${key}`);
    }
  };

  walk(record, "record");
  return leaks;
}

/** Photo identity, as far as jsdom's Blob exposes it (no `arrayBuffer()`). */
function photoOf(r: SyncStoredRecord): Blob | undefined {
  return (r as { photo?: Blob }).photo;
}

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

describe("Property 8: No photo data ever reaches the wire", () => {
  it("emits no photo key, no binary value, and no data: string at any depth", () => {
    fc.assert(
      fc.property(arbPhotoHostileRecord, (record) => {
        const wire = toEventRecord(record as StoredRecord);

        expect(findPhotoLeaks(wire)).toEqual([]);
        expect("photo" in wire).toBe(false);
        // A string *beginning* with data: is what Req 16.2 names, so match the
        // quote that opens a JSON string value.
        expect(JSON.stringify(wire)).not.toContain('"data:');
      }),
      { numRuns: 300 },
    );
  });

  it("emits no photo data through serializeForPush either", () => {
    fc.assert(
      fc.property(arbPhotoHostileRecord, (record) => {
        const { record: wire, bytes } = serializeForPush(record as StoredRecord);

        expect(findPhotoLeaks(wire)).toEqual([]);
        const json = JSON.stringify(wire);
        expect(json).not.toContain('"data:');
        // Serializable at all — a Blob or a cycle would have broken this.
        expect(bytes).toBe(new TextEncoder().encode(json).length);
      }),
      { numRuns: 300 },
    );
  });

  it("leaves the photo held in the Local_Store unchanged (Req 16.1)", () => {
    fc.assert(
      fc.property(arbPhotoHostileRecord, (record) => {
        const before = photoOf(record);
        const size = before?.size;
        const type = before?.type;

        toEventRecord(record as StoredRecord);
        serializeForPush(record as StoredRecord);

        const after = photoOf(record);
        expect(after).toBe(before);
        expect(after?.size).toBe(size);
        expect(after?.type).toBe(type);
      }),
      { numRuns: 200 },
    );
  });
});
