// Feature: cloud-sync, task 2.6 — tombstone visibility, transaction
// atomicity, photo attach, and the tombstone sweep.
//
// Validates: Requirements 5.3, 5.6, 9.6, 10.7
//
// jsdom has no IndexedDB, so `fake-indexeddb/auto` installs a real one: every
// assertion below is about what an actual store holds after an actual
// transaction, which an in-memory stand-in could not honestly show.
//
// fake-indexeddb clones stored values with Node's `structuredClone`, which
// turns a jsdom `Blob` into an empty object, so photo fixtures use Node's
// `Blob` — it survives the store faithfully, bytes included.

import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DB_NAME,
  TOMBSTONE_RETENTION_MS,
  attachPhoto,
  deleteEvent,
  getAllRecords,
  getEvents,
  getOutboxBatch,
  getOutboxCount,
  getRecord,
  isTombstone,
  putEvent,
  removeOutboxIds,
  sweepTombstones,
  type MealEvent,
  type StoredRecord,
} from "./db";

const PHOTO_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10]);
/** Cast because `db.ts` is typed against the DOM `Blob`; see the header note. */
function makePhoto(): Blob {
  return new NodeBlob([PHOTO_BYTES], { type: "image/jpeg" }) as unknown as Blob;
}

function meal(id: string, createdAt: number): Omit<MealEvent, "updatedAt"> {
  return {
    id,
    type: "meal",
    createdAt,
    dish: "Instant ramen",
    ingredients: [
      { name: "wheat noodles", confidence: "confident" },
      { name: "palm oil", confidence: "maybe" },
    ],
    note: "late, spicy",
  };
}

/**
 * A clock that compares as a number but cannot be stored: `valueOf` keeps
 * `nextRevisionTime` working, so `putEvent`/`deleteEvent` write their record
 * successfully and then fail on the Outbox entry, where the object itself is
 * the value. That is a mid-transaction write failure, which is the only honest
 * way to observe whether the record write rolls back with it.
 */
const uncloneableClock = { valueOf: () => 1 } as unknown as number;

/** Empty both stores so each test sees only its own records. */
async function resetStores(): Promise<void> {
  // Force `db.ts` to open (and upgrade) the database first, so the raw open
  // below never creates it at the wrong version.
  await getOutboxCount();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["events", "outbox"], "readwrite");
    tx.objectStore("events").clear();
    tx.objectStore("outbox").clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

beforeEach(resetStores);

describe("tombstone visibility (Req 9.6)", () => {
  it("getEvents excludes tombstones while getAllRecords includes them", async () => {
    await putEvent(meal("keep-1", 1_000), { enqueue: false });
    await putEvent(meal("gone", 2_000), { enqueue: false });
    await putEvent(meal("keep-2", 3_000), { enqueue: false });

    await deleteEvent("gone");

    const events = await getEvents();
    expect(events.map((e) => e.id)).toEqual(["keep-2", "keep-1"]); // newest first
    expect(events.every((e) => !isTombstone(e))).toBe(true);

    const all = await getAllRecords();
    expect(all).toHaveLength(3);
    expect(all.filter(isTombstone).map((r) => r.id)).toEqual(["gone"]);

    const raw = await getRecord("gone");
    expect(raw).toBeDefined();
    expect(isTombstone(raw!)).toBe(true);
  });
});

describe("deleteEvent atomicity (Req 5.3)", () => {
  it("removes content, writes the tombstone, and queues the id in one transaction", async () => {
    await putEvent({ ...meal("del", 1_000), photo: makePhoto() }, { enqueue: false });
    expect(await getOutboxCount()).toBe(0);

    const revision = await deleteEvent("del", { now: 9_000 });

    // Exactly one entry for the id, and it is the tombstone.
    const all = await getAllRecords();
    expect(all).toHaveLength(1);
    const stored = all[0] as StoredRecord & Record<string, unknown>;
    expect(isTombstone(stored)).toBe(true);
    expect(stored.updatedAt).toBe(revision);
    // Identity and revision only: no note text, no photo, no type-specific field.
    expect(Object.keys(stored).sort()).toEqual(
      ["createdAt", "deleted", "id", "type", "updatedAt"].sort(),
    );
    expect(stored.photo).toBeUndefined();
    expect(stored.note).toBeUndefined();
    expect(stored.dish).toBeUndefined();
    expect(stored.createdAt).toBe(1_000); // identity kept for the merge rule

    // The Outbox entry rode the same transaction, exactly once for the id.
    expect(await getOutboxCount()).toBe(1);
    expect(await getOutboxBatch(10)).toEqual(["del"]);
  });

  it("leaves both stores unchanged and names the id when the transaction fails", async () => {
    const before = await putEvent({ ...meal("del-fail", 1_000), photo: makePhoto() }, {
      enqueue: false,
      now: 5_000,
    });

    await expect(deleteEvent("del-fail", { now: uncloneableClock })).rejects.toThrow(/del-fail/);

    // The tombstone write was issued before the failing Outbox write, so this
    // is the rollback: the event and its photo are still there, untombstoned.
    const record = await getRecord("del-fail");
    expect(record).toBeDefined();
    expect(isTombstone(record!)).toBe(false);
    expect(record!.updatedAt).toBe(before);
    const photo = (record as MealEvent).photo as unknown as NodeBlob;
    expect(photo.size).toBe(PHOTO_BYTES.byteLength);
    expect(await getOutboxCount()).toBe(0);
  });

  it("leaves both stores unchanged when a putEvent transaction fails", async () => {
    const before = await putEvent(meal("put-fail", 1_000), { enqueue: false, now: 5_000 });

    await expect(
      putEvent({ ...meal("put-fail", 1_000), dish: "Edited" }, { now: uncloneableClock }),
    ).rejects.toThrow(/put-fail/);

    const record = await getRecord("put-fail");
    expect((record as MealEvent).dish).toBe("Instant ramen");
    expect(record!.updatedAt).toBe(before);
    expect(await getOutboxCount()).toBe(0);
  });
});

describe("attachPhoto (Req 10.7)", () => {
  it("stores the photo without touching updatedAt or the Outbox", async () => {
    const revision = await putEvent(meal("photo", 1_000), { enqueue: false, now: 5_000 });
    expect(await getOutboxCount()).toBe(0);

    await attachPhoto("photo", makePhoto());

    const record = (await getRecord("photo")) as MealEvent;
    const photo = record.photo as unknown as NodeBlob;
    expect(photo.size).toBe(PHOTO_BYTES.byteLength);
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(PHOTO_BYTES);
    // The revision is what the merge rule reads: attaching a photo is not an edit.
    expect(record.updatedAt).toBe(revision);
    expect(record.dish).toBe("Instant ramen");
    expect(record.note).toBe("late, spicy");
    expect(await getOutboxCount()).toBe(0);
    expect(await getOutboxBatch(10)).toEqual([]);
  });

  it("is a no-op for a tombstoned id and for an unknown id", async () => {
    await putEvent(meal("tombstoned", 1_000), { enqueue: false });
    const revision = await deleteEvent("tombstoned", { now: 9_000 });
    const queuedBefore = await getOutboxBatch(10);

    await attachPhoto("tombstoned", makePhoto());
    await attachPhoto("never-existed", makePhoto());

    const record = (await getRecord("tombstoned")) as StoredRecord & Record<string, unknown>;
    expect(isTombstone(record)).toBe(true);
    expect(record.photo).toBeUndefined();
    expect(record.updatedAt).toBe(revision);
    expect(await getRecord("never-existed")).toBeUndefined();
    expect(await getOutboxBatch(10)).toEqual(queuedBefore);
  });
});

describe("sweepTombstones (Req 5.6)", () => {
  const now = 400 * 24 * 60 * 60 * 1000; // well past the retention window
  const expired = now - TOMBSTONE_RETENTION_MS - 1;
  const boundary = now - TOMBSTONE_RETENTION_MS;

  /** Write a tombstone with a chosen Revision_Time, then clear its Outbox entry. */
  async function tombstone(id: string, updatedAt: number, keepQueued: boolean): Promise<void> {
    await putEvent(meal(id, 1_000), { enqueue: false, now: updatedAt - 1 });
    await deleteEvent(id, { now: updatedAt });
    if (!keepQueued) await removeOutboxIds([id]);
  }

  it("deletes expired tombstones, and skips ids still in the Outbox", async () => {
    await tombstone("expired-unqueued", expired, false);
    await tombstone("expired-queued", expired, true);
    await tombstone("boundary", boundary, false);
    await tombstone("recent", now - 1_000, false);
    // A real event older than the window is not a tombstone, so it stays.
    await putEvent(meal("old-event", 1_000), { enqueue: false, now: expired });

    const deleted = await sweepTombstones(now);

    expect(deleted).toBe(1);
    expect(await getRecord("expired-unqueued")).toBeUndefined();
    // Still queued: sweeping it would drop a deletion the service never saw.
    expect(await getRecord("expired-queued")).toBeDefined();
    expect(await getRecord("boundary")).toBeDefined(); // exactly 180 days is retained
    expect(await getRecord("recent")).toBeDefined();
    expect(await getRecord("old-event")).toBeDefined();

    // The Outbox is untouched by the sweep.
    expect(await getOutboxBatch(10)).toEqual(["expired-queued"]);
  });

  it("sweeps an id once its Outbox entry is gone", async () => {
    await tombstone("settled", expired, true);
    expect(await sweepTombstones(now)).toBe(0);

    await removeOutboxIds(["settled"]);

    expect(await sweepTombstones(now)).toBe(1);
    expect(await getRecord("settled")).toBeUndefined();
  });
});
