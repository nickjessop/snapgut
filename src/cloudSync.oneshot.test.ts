// The two one-shot operations: `enqueueEntireLocalStore` (Req 10.9, 10.10,
// 13.13) and `deleteCloudCopy` (Req 17.4, 17.5).
//
// Both are I/O shell functions whose whole content is what they write, so the
// store they write to is a real one: jsdom has no IndexedDB, and
// `fake-indexeddb/auto` installs an implementation whose transactions actually
// commit. Every assertion below reads the store back afterwards.
//
// Two environment notes, shared with the other shell tests:
//   - fake-indexeddb clones stored values with Node's `structuredClone`, which
//     flattens a jsdom `Blob` into an empty object, so the photo fixture uses
//     Node's own `Blob`.
//   - `syncRequest` is the single transport, so the Sync_Service is emulated by
//     stubbing global `fetch` — the seam `fetchWithTimeout` calls.

import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_DATA_PATH,
  PULL_PATH,
  PUSH_PATH,
  deleteCloudCopy,
  enqueueEntireLocalStore,
  formatCursor,
  hydrateSyncState,
  resetCloudSyncForTests,
  runPushPhase,
  runSyncCycle,
} from "./cloudSync";
import {
  DB_NAME,
  enqueueIds,
  getAllRecords,
  getMeta,
  getOutboxBatch,
  getOutboxCount,
  setMeta,
  type StoredRecord,
} from "./db";
import { clearToken, setToken } from "./session";
import {
  applyEntitlement,
  clearPersistedSyncSettingsForTests,
  isDestinationEnabled,
  resetSyncSettingsForTests,
  restore as restoreSyncSettings,
  setDestinationEnabled,
} from "./syncSettings";

const PRO_ENTITLEMENT = { pro: true, proUntil: null };

/** The cursor already stored before an operation runs. */
const SEEDED_CURSOR = formatCursor(1, 100);
/** The cursor the Sync_Service hands back from a fresh (post-purge) timeline. */
const RECOVERY_CURSOR = formatCursor(2, 7);

// ---------------------------------------------------------------------------
// Raw store access, so seeding and inspection never go through the code under
// test
// ---------------------------------------------------------------------------

let rawConnection: IDBDatabase | null = null;

async function rawDb(): Promise<IDBDatabase> {
  if (rawConnection) return rawConnection;
  // Let `db.ts` create and upgrade the database first, so this open never
  // creates it at the wrong version.
  await getOutboxCount();
  rawConnection = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return rawConnection;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function resetStores(): Promise<void> {
  const db = await rawDb();
  const tx = db.transaction(["events", "outbox", "meta"], "readwrite");
  tx.objectStore("events").clear();
  tx.objectStore("outbox").clear();
  tx.objectStore("meta").clear();
  await txDone(tx);
}

/** Write records straight into `events`, bypassing the Outbox entirely. */
async function seedRecords(records: StoredRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await rawDb();
  const tx = db.transaction("events", "readwrite");
  for (const record of records) tx.objectStore("events").put(record);
  await txDone(tx);
}

/** Every queued id with the clock value it was queued at. */
async function outboxRows(): Promise<{ id: string; queuedAt: number }[]> {
  const db = await rawDb();
  const tx = db.transaction("outbox");
  const rows = await new Promise<{ id: string; queuedAt: number }[]>((resolve, reject) => {
    const req = tx.objectStore("outbox").getAll();
    req.onsuccess = () => resolve(req.result as { id: string; queuedAt: number }[]);
    req.onerror = () => reject(req.error);
  });
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PHOTO_BYTES = Uint8Array.from([1, 2, 3, 4]);

function photoBlob(): Blob {
  return new NodeBlob([PHOTO_BYTES.buffer as ArrayBuffer], {
    type: "image/jpeg",
  }) as unknown as Blob;
}

/** A meal, a check-in, and a Tombstone — the three shapes the Outbox can carry. */
function localTimeline(): StoredRecord[] {
  return [
    {
      id: "meal-1",
      type: "meal",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      dish: "oatmeal",
      ingredients: [{ name: "oats", confidence: "confident" }],
      photo: photoBlob(),
    },
    {
      id: "checkin-1",
      type: "checkin",
      createdAt: 1_700_000_002_000,
      updatedAt: 1_700_000_002_000,
      stress: "low",
    },
    {
      id: "bowel-1",
      type: "bowel",
      createdAt: 1_700_000_003_000,
      updatedAt: 1_700_000_004_000,
      deleted: true,
    },
  ] as StoredRecord[];
}

// ---------------------------------------------------------------------------
// The emulated Sync_Service
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null } as unknown as Headers,
    json: async () => body,
  } as unknown as Response;
}

/** Every request the stub saw, in order, with the ids a push carried. */
interface RequestLog {
  calls: { method: string; url: string; ids: string[] }[];
}

interface Script {
  /** Pull answers, served in order; the last one repeats. */
  pulls: unknown[];
  /** Answer for `DELETE /api/sync/data`. */
  del?: Response;
}

function installFetch(script: Script): RequestLog {
  const log: RequestLog = { calls: [] };
  let pulls = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");

      if (url.startsWith(PUSH_PATH)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { records?: { id: string }[] };
        const ids = (body.records ?? []).map((r) => r.id);
        log.calls.push({ method, url, ids });
        return Promise.resolve(
          jsonResponse(200, {
            outcomes: ids.map((id) => ({ id, outcome: "stored" })),
            highestSequence: 10,
            entitlement: PRO_ENTITLEMENT,
          }),
        );
      }

      if (url.startsWith(PULL_PATH)) {
        log.calls.push({ method, url, ids: [] });
        const index = Math.min(pulls++, script.pulls.length - 1);
        return Promise.resolve(jsonResponse(200, script.pulls[index]));
      }

      if (url.startsWith(CLOUD_DATA_PATH)) {
        log.calls.push({ method, url, ids: [] });
        return Promise.resolve(
          script.del ?? jsonResponse(200, { ok: true, deleted: 3, entitlement: PRO_ENTITLEMENT }),
        );
      }

      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );

  return log;
}

/** A signed-in, Pro, Cloud-enabled device holding `records` locally. */
async function setUpDevice(records: StoredRecord[]): Promise<void> {
  await resetStores();
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();

  setToken("session-token-for-tests");
  await restoreSyncSettings();
  applyEntitlement(PRO_ENTITLEMENT);
  setDestinationEnabled("cloud", true);

  await seedRecords(records);
  await hydrateSyncState();
}

beforeEach(() => {
  clearToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  clearToken();
});

// ---------------------------------------------------------------------------
// enqueueEntireLocalStore (Req 10.9, 10.10)
// ---------------------------------------------------------------------------

describe("enqueueEntireLocalStore", () => {
  it("queues every Log_Event and Tombstone id and leaves the Local_Store alone", async () => {
    const records = localTimeline();
    await setUpDevice(records);

    const queued = await enqueueEntireLocalStore();

    expect(queued).toBe(3);
    expect((await outboxRows()).map((r) => r.id)).toEqual(["bowel-1", "checkin-1", "meal-1"]);

    // Req 10.9 — the Log_Events stay put until the Sync_Service acknowledges them.
    const stored = await getAllRecords();
    expect(stored.map((r) => r.id).sort()).toEqual(["bowel-1", "checkin-1", "meal-1"]);
    const meal = stored.find((r) => r.id === "meal-1") as { photo?: Blob };
    expect(meal.photo).toBeDefined();
  });

  it("keeps the original queuedAt of an id that was already waiting", async () => {
    await setUpDevice(localTimeline());
    await enqueueIds(["meal-1"], { now: 1_000 });

    await enqueueEntireLocalStore();

    const rows = await outboxRows();
    expect(rows.find((r) => r.id === "meal-1")?.queuedAt).toBe(1_000);
  });

  it("queues nothing on an empty Local_Store, and the next push sends nothing", async () => {
    await setUpDevice([]);
    const log = installFetch({ pulls: [{ records: [], cursor: SEEDED_CURSOR, hasMore: false }] });

    // Req 10.10 — zero Log_Events and zero Tombstones.
    expect(await enqueueEntireLocalStore()).toBe(0);
    expect(await getOutboxCount()).toBe(0);

    const push = await runPushPhase();
    expect(push.status).toBe("complete");
    expect(push.requests).toBe(0);
    expect(push.sent).toBe(0);
    // No Tombstone was invented for anything the cloud might hold.
    expect(await getAllRecords()).toEqual([]);
    expect(log.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cursor-invalid recovery (Req 13.13)
// ---------------------------------------------------------------------------

describe("cursor-invalid recovery", () => {
  it("re-enqueues the whole timeline and pushes it before the cursor advances", async () => {
    await setUpDevice(localTimeline());
    await setMeta("cursor", SEEDED_CURSOR);

    const log = installFetch({
      pulls: [
        // Req 13.13 — the stored cursor is reported as no longer valid.
        { error: "cursor_invalid", cursor: null, entitlement: PRO_ENTITLEMENT },
        { records: [], cursor: RECOVERY_CURSOR, hasMore: false, entitlement: PRO_ENTITLEMENT },
      ],
    });

    const result = await runSyncCycle();

    expect(result.cursorReset).toBe(true);
    expect(result.status).toBe("complete");
    expect(result.recovery?.enqueued).toBe(3);
    expect(result.recovery?.push?.sent).toBe(3);

    // The order is the requirement: the invalidated pull, then the push carrying
    // every local id, then the pull that advances the cursor again.
    const sequence = log.calls.map((c) => (c.url.startsWith(PUSH_PATH) ? "push" : "pull"));
    expect(sequence).toEqual(["pull", "push", "pull"]);
    expect(log.calls[1].ids.slice().sort()).toEqual(["bowel-1", "checkin-1", "meal-1"]);

    // The advanced cursor is the recovery pull's, and every id was acknowledged.
    expect(await getMeta("cursor")).toBe(RECOVERY_CURSOR);
    expect(await getOutboxCount()).toBe(0);
  });

  it("keeps the cursor unset and every id queued when the recovery push fails", async () => {
    await setUpDevice(localTimeline());
    await setMeta("cursor", SEEDED_CURSOR);

    const log = installFetch({
      pulls: [{ error: "cursor_invalid", cursor: null, entitlement: PRO_ENTITLEMENT }],
    });
    // Replace the push answer with a 5xx, leaving the pull script in place.
    const original = globalThis.fetch as unknown as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(PUSH_PATH)) {
        log.calls.push({ method: "POST", url: String(input), ids: [] });
        return Promise.resolve(jsonResponse(503, { error: "server_error" }));
      }
      return original(input, init);
    });

    const result = await runSyncCycle();

    expect(result.cursorReset).toBe(true);
    expect(result.status).toBe("failed");
    // Req 6.8 applied to the recovery: no pull followed the failed push.
    expect(result.recovery?.pull).toBeNull();
    expect(log.calls.map((c) => (c.url.startsWith(PUSH_PATH) ? "push" : "pull"))).toEqual([
      "pull",
      "push",
    ]);
    expect(await getMeta("cursor")).toBeNull();
    expect((await getOutboxBatch(10)).sort()).toEqual(["bowel-1", "checkin-1", "meal-1"]);
  });
});

// ---------------------------------------------------------------------------
// deleteCloudCopy (Req 17.4, 17.5)
// ---------------------------------------------------------------------------

describe("deleteCloudCopy", () => {
  it("disables the destination, resets the cursor, and empties the Outbox on success", async () => {
    const records = localTimeline();
    await setUpDevice(records);
    await enqueueIds(["meal-1", "checkin-1"], { now: 1_000 });
    await setMeta("cursor", SEEDED_CURSOR);

    const log = installFetch({ pulls: [] });

    const result = await deleteCloudCopy();

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(3);
    expect(result.localCleared).toBe(true);
    expect(log.calls).toEqual([
      { method: "DELETE", url: CLOUD_DATA_PATH, ids: [] },
    ]);

    // Req 17.5 — the local consequences.
    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(await getOutboxCount()).toBe(0);
    expect(await getMeta("cursor")).toBeNull();

    // …and the ones that must not happen: every Log_Event and Photo is retained.
    const stored = await getAllRecords();
    expect(stored.map((r) => r.id).sort()).toEqual(["bowel-1", "checkin-1", "meal-1"]);
    const meal = stored.find((r) => r.id === "meal-1") as { photo?: NodeBlob };
    const bytes = new Uint8Array((await meal.photo!.arrayBuffer()) as ArrayBuffer);
    expect(Array.from(bytes)).toEqual(Array.from(PHOTO_BYTES));
  });

  it("changes nothing locally when the Sync_Service reports the deletion incomplete", async () => {
    await setUpDevice(localTimeline());
    await enqueueIds(["meal-1"], { now: 1_000 });
    await setMeta("cursor", SEEDED_CURSOR);

    installFetch({
      pulls: [],
      del: jsonResponse(500, { error: "delete_incomplete", entitlement: PRO_ENTITLEMENT }),
    });

    const result = await deleteCloudCopy();

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("service");
    expect(result.localCleared).toBe(false);

    expect(isDestinationEnabled("cloud")).toBe(true);
    expect(await getOutboxBatch(10)).toEqual(["meal-1"]);
    expect(await getMeta("cursor")).toBe(SEEDED_CURSOR);
    expect((await getAllRecords()).length).toBe(3);
  });
});
