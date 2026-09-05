// Example-based tests for the wire codec (task 6.1). The universal properties
// live in the Property 6–10 suites; these pin the specific shapes the codec is
// meant to produce.

import { describe, expect, it } from "vitest";
import { MAX_RECORD_BYTES, SCHEMA_VERSION, fromEventRecord, serializeForPush, toEventRecord } from "./cloudSync";
import type { BowelEvent, CheckinEvent, MealEvent, Tombstone } from "./db";

const meal: MealEvent = {
  id: "m1",
  type: "meal",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  dish: "  ramen, \"instant\"\n",
  ingredients: [
    { name: "wheat noodles", confidence: "confident" },
    { name: "palm oil", confidence: "maybe" },
  ],
};

describe("toEventRecord", () => {
  it("stamps schemaVersion 2 on every record", () => {
    expect(toEventRecord(meal).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("omits an absent optional field and keeps a present empty one", () => {
    expect("note" in toEventRecord(meal)).toBe(false);
    expect(toEventRecord({ ...meal, note: "" }).note).toBe("");

    const bowel: BowelEvent = { id: "b1", type: "bowel", createdAt: 1, updatedAt: 2, bristol: 4 };
    expect("symptoms" in toEventRecord(bowel)).toBe(false);
    expect(toEventRecord({ ...bowel, symptoms: [] }).symptoms).toEqual([]);

    const checkin: CheckinEvent = { id: "c1", type: "checkin", createdAt: 1, updatedAt: 2 };
    expect("stress" in toEventRecord(checkin)).toBe(false);
    expect("sleep" in toEventRecord(checkin)).toBe(false);
  });

  it("never emits a photo, a Blob, or a data: string", () => {
    const withPhoto: MealEvent = {
      ...meal,
      photo: new Blob([Uint8Array.from([1, 2, 3]).buffer], { type: "image/jpeg" }),
      unknownFields: {
        thumb: "data:image/png;base64,AAAA",
        nested: { photo: new Blob([]) },
        mood: "fine",
      },
    };
    const wire = toEventRecord(withPhoto);
    expect("photo" in wire).toBe(false);
    expect("thumb" in wire).toBe(false);
    expect("nested" in wire).toBe(false);
    expect(wire.mood).toBe("fine");
    expect(JSON.stringify(wire)).not.toContain("data:");
  });

  it("re-emits preserved unknown fields verbatim at the top level", () => {
    const wire = toEventRecord({ ...meal, unknownFields: { v4Only: { nested: "x" }, hydration: 3 } });
    expect(wire.v4Only).toEqual({ nested: "x" });
    expect(wire.hydration).toBe(3);
  });

  it("emits a tombstone with no content", () => {
    const tombstone: Tombstone = {
      id: "t1",
      type: "meal",
      createdAt: 10,
      updatedAt: 20,
      deleted: true,
      unknownFields: { mood: "n/a" },
    };
    const wire = toEventRecord(tombstone);
    expect(wire).toEqual({
      id: "t1",
      type: "meal",
      createdAt: 10,
      updatedAt: 20,
      deleted: true,
      schemaVersion: SCHEMA_VERSION,
      mood: "n/a",
    });
  });
});

describe("fromEventRecord", () => {
  it("round-trips an event through the wire", () => {
    expect(fromEventRecord(toEventRecord(meal))).toEqual(meal);
  });

  it("round-trips a tombstone as a tombstone", () => {
    const tombstone: Tombstone = { id: "t2", type: "bowel", createdAt: 1, updatedAt: 9, deleted: true };
    expect(fromEventRecord(toEventRecord(tombstone))).toEqual(tombstone);
  });

  it("returns null instead of throwing for malformed records", () => {
    const wire = toEventRecord(meal);
    const cases: unknown[] = [
      null,
      undefined,
      42,
      "meal",
      [],
      {},
      { ...wire, id: undefined },
      { ...wire, createdAt: "yesterday" },
      { ...wire, updatedAt: null },
      { ...wire, type: "snack" },
      { ...wire, note: 7 },
      { ...wire, ingredients: [{ name: "oats", confidence: "sure" }] },
      { ...wire, ingredients: "oats; milk" },
      { ...wire, type: "symptom", symptoms: [{ id: "bloating", severity: "awful" }] },
      { ...wire, type: "bowel", bristol: 0 },
      { ...wire, type: "bowel", bristol: 8 },
      { ...wire, type: "bowel", bristol: 3.5 },
      { ...wire, type: "bowel" }, // a bowel event with no Bristol score
      { ...wire, type: "checkin", stress: "extreme" },
      { ...wire, type: "checkin", sleep: "meh" },
      { ...wire, deleted: "yes" },
    ];
    for (const bad of cases) {
      expect(fromEventRecord(bad)).toBeNull();
    }
  });

  it("skips a tombstone whose payload is out of domain", () => {
    const wire = { id: "t3", type: "bowel", createdAt: 1, updatedAt: 2, deleted: true, bristol: 9 };
    expect(fromEventRecord(wire)).toBeNull();
  });

  it("merges a newer schemaVersion by its recognized fields, preserving the rest", () => {
    const parsed = fromEventRecord({
      ...toEventRecord(meal),
      schemaVersion: 4,
      moodScore: 7,
      vendorTag: { nested: "keep" },
    });
    expect(parsed).toEqual({ ...meal, unknownFields: { moodScore: 7, vendorTag: { nested: "keep" } } });
  });

  it("treats a recognized field absent from an older record as unset", () => {
    expect(fromEventRecord({ id: "m2", type: "meal", createdAt: 1, updatedAt: 2, schemaVersion: 1 })).toEqual({
      id: "m2",
      type: "meal",
      createdAt: 1,
      updatedAt: 2,
      dish: "",
      ingredients: [],
    });
  });
});

describe("serializeForPush", () => {
  it("reports the serialized size and keeps unknown fields that fit", () => {
    const { record, bytes, omittedUnknown } = serializeForPush({ ...meal, unknownFields: { mood: "ok" } });
    expect(record.mood).toBe("ok");
    expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(record)).length);
    expect(bytes).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(omittedUnknown).toBe(false);
  });

  it("drops preserved unknown fields for that push when they blow the 16 KiB cap", () => {
    // Not base64-only, so it is bulk text rather than Photo data (Req 16.2).
    const bulky = { ...meal, unknownFields: { blob: "long, wordy note. ".repeat(1_500) } };
    const { record, bytes, omittedUnknown } = serializeForPush(bulky);
    expect(omittedUnknown).toBe(true);
    expect("blob" in record).toBe(false);
    expect(bytes).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    // The stored record keeps them — the omission is per push (Req 16.8).
    expect(bulky.unknownFields.blob.length).toBeGreaterThan(MAX_RECORD_BYTES);
    expect(toEventRecord(bulky).blob).toBe(bulky.unknownFields.blob);
  });

  it("reports no omission when the record is over the cap on its own", () => {
    const huge: MealEvent = { ...meal, dish: "y".repeat(MAX_RECORD_BYTES + 1) };
    const { record, bytes, omittedUnknown } = serializeForPush(huge);
    expect(omittedUnknown).toBe(false);
    expect(bytes).toBeGreaterThan(MAX_RECORD_BYTES);
    expect(record.dish).toBe(huge.dish);
  });
});
