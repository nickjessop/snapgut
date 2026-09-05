// Feature: cloud-sync, task 2.6 — the v2→v3 schema upgrade.
//
// Validates: Requirements 5.4, 5.5
//
// A real v2 database is seeded through the raw IndexedDB API (version 2, an
// `events` store with `by-createdAt`, records carrying no `updatedAt`, one meal
// carrying a photo). Opening it through `db.ts` runs the real v3 upgrade, so
// what is asserted afterwards is the migration's own output rather than a
// stand-in for it.
//
// Two environment notes:
// - jsdom has no IndexedDB, so `fake-indexeddb/auto` installs a real one.
// - fake-indexeddb clones stored values with Node's `structuredClone`, which
//   turns a jsdom `Blob` into an empty object. Node's own `Blob` is
//   serializable, so photo fixtures use that: it survives the store faithfully,
//   which is exactly what "the photo is carried through" needs to mean here.
//
// `db.ts` memoizes its connection and `DB_NAME` is a constant, so the v2 seed
// runs in `beforeAll` before any `db.ts` call opens the database, and this file
// holds nothing but the migration.

import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DB_NAME,
  didUpgradeFail,
  getAllRecords,
  getEvents,
  getMeta,
  getOutboxCount,
  getRecord,
  setMeta,
  sweepTombstones,
  type MealEvent,
  type StoredRecord,
} from "./db";

const PHOTO_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10]);
/** Cast because `db.ts` is typed against the DOM `Blob`; see the header note. */
const photo = new NodeBlob([PHOTO_BYTES], { type: "image/jpeg" }) as unknown as Blob;

/** Exactly what v2 held: no `updatedAt` anywhere. */
const v2Records: Record<string, unknown>[] = [
  {
    id: "m1",
    type: "meal",
    createdAt: 1_000,
    dish: "Instant ramen",
    ingredients: [
      { name: "wheat noodles", confidence: "confident" },
      { name: "palm oil", confidence: "maybe" },
    ],
    note: "late, spicy",
    photo,
  },
  { id: "m2", type: "meal", createdAt: 2_000, dish: "Toast", ingredients: [] },
  {
    id: "s1",
    type: "symptom",
    createdAt: 3_000,
    symptoms: [{ id: "bloating", severity: "moderate" }],
  },
  {
    id: "b1",
    type: "bowel",
    createdAt: 4_000,
    bristol: 5,
    symptoms: [{ id: "urgency", severity: "mild" }],
    note: "",
  },
  { id: "c1", type: "checkin", createdAt: 5_000, stress: "high", sleep: "poor" },
  // Not an integer `createdAt`, so the backfill must fall back to the upgrade
  // clock rather than copying it (Req 5.4).
  { id: "x1", type: "meal", createdAt: 5_500.5, dish: "Odd clock", ingredients: [] },
];

/** Open at version 2 with the v2 schema and write the seed records. */
function seedV2(): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 2);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore("events", { keyPath: "id" });
      store.createIndex("by-createdAt", "createdAt");
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("events", "readwrite");
      for (const record of v2Records) tx.objectStore("events").put(record);
      tx.oncomplete = () => {
        // Close, or the v3 version bump blocks on this connection.
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    };
  });
}

let upgradeStartedAt = 0;
let migrated: StoredRecord[] = [];

function byId(id: string): StoredRecord {
  const found = migrated.find((r) => r.id === id);
  expect(found, `record ${id} survived the upgrade`).toBeDefined();
  return found!;
}

beforeAll(async () => {
  await seedV2();
  upgradeStartedAt = Date.now();
  // The first `db.ts` read opens at v3, which runs the upgrade.
  migrated = await getAllRecords();
});

describe("v2→v3 migration", () => {
  it("completes the upgrade", () => {
    expect(didUpgradeFail()).toBe(false);
  });

  it("retains every pre-existing record", () => {
    expect(migrated).toHaveLength(v2Records.length);
    expect(migrated.map((r) => r.id).sort()).toEqual(v2Records.map((r) => r.id as string).sort());
  });

  it("sets updatedAt to createdAt on every record that has an integer createdAt", () => {
    for (const seeded of v2Records) {
      if (!Number.isInteger(seeded.createdAt)) continue;
      const record = byId(seeded.id as string);
      expect(record.updatedAt).toBe(seeded.createdAt);
    }
  });

  it("falls back to the upgrade clock for a non-integer createdAt", () => {
    const record = byId("x1");
    expect(record.createdAt).toBe(5_500.5);
    expect(record.updatedAt).not.toBe(5_500.5);
    expect(Number.isInteger(record.updatedAt)).toBe(true);
    expect(record.updatedAt).toBeGreaterThanOrEqual(upgradeStartedAt);
    expect(record.updatedAt).toBeLessThanOrEqual(Date.now());
  });

  it("preserves the photo, bytes included", async () => {
    const meal = byId("m1") as MealEvent;
    expect(meal.photo).toBeDefined();
    const stored = meal.photo as unknown as NodeBlob;
    expect(stored.size).toBe(PHOTO_BYTES.byteLength);
    expect(stored.type).toBe("image/jpeg");
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(PHOTO_BYTES);
  });

  it("leaves a meal that had no photo without one", () => {
    expect((byId("m2") as MealEvent).photo).toBeUndefined();
  });

  it("preserves every pre-existing field value", () => {
    for (const seeded of v2Records) {
      const record = byId(seeded.id as string) as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(seeded)) {
        if (key === "photo") continue; // compared by bytes above
        expect(record[key], `${seeded.id as string}.${key}`).toEqual(value);
      }
      // The backfill adds `updatedAt` and nothing else.
      expect(Object.keys(record).sort()).toEqual([...Object.keys(seeded), "updatedAt"].sort());
    }
  });

  it("keeps the migrated records readable through getEvents, newest first", async () => {
    const events = await getEvents();
    expect(events).toHaveLength(v2Records.length);
    const times = events.map((e) => e.createdAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("adds the outbox and meta stores without queuing anything", async () => {
    expect(await getOutboxCount()).toBe(0);
    expect(await getMeta("cursor")).toBeUndefined();
    await setMeta("cursor", "7:42");
    expect(await getMeta<string>("cursor")).toBe("7:42");
  });

  it("adds the by-updatedAt index the sweep reads", async () => {
    // The sweep scans `by-updatedAt`; a missing index would throw here. The
    // migrated records are events, not tombstones, so nothing is deleted.
    expect(await sweepTombstones(Date.now())).toBe(0);
    expect(await getAllRecords()).toHaveLength(v2Records.length);
    expect(await getRecord("m1")).toBeDefined();
  });
});
