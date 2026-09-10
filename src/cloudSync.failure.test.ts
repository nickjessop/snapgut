// Feature: cloud-sync, Property 20: Failure preserves local data, the cursor,
// and the last-sync timestamp
//
// Validates: Requirements 4.4, 4.5, 6.8, 7.5
//
// The phases under test are the I/O shell's `runPushPhase` / `runPullPhase`, so
// the store they write to is a real one: jsdom has no IndexedDB, and
// `fake-indexeddb/auto` installs an implementation whose transactions actually
// commit and abort. Every assertion below is about what an actual store holds
// after an actual failure, which an in-memory stand-in could not honestly show.
//
// Two environment notes:
//   - fake-indexeddb clones stored values with Node's `structuredClone`, which
//     flattens a jsdom `Blob` into an empty object, so photo fixtures use Node's
//     own `Blob` (as `db.atomicity.test.ts` does).
//   - `syncRequest` is the single transport, so a failure is injected by stubbing
//     global `fetch` — the seam `fetchWithTimeout` calls. The timeout point is
//     injected as a rejection carrying `SYNC_TIMEOUT_MESSAGE`, which is exactly
//     the value `fetchWithTimeout` throws when its 30-second abort fires, so the
//     phase sees what a real timeout hands it without waiting 30 seconds.
//
// Scoping of the generated remote records: pulled ids are disjoint from local
// ids. A pulled record that *wins* the merge for a local id is supposed to
// replace it, so mixing the two would turn "locally originated data is
// unchanged" into a restatement of the merge rule (Properties 1–4 own that).
// Keeping them disjoint makes Requirement 4.4's local half exact.

import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  PULL_PATH,
  PUSH_PATH,
  SYNC_TIMEOUT_MESSAGE,
  formatCursor,
  fromEventRecord,
  getSyncState,
  hydrateSyncState,
  resetCloudSyncForTests,
  runPullPhase,
  runPushPhase,
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
  clearPersistedSyncSettingsForTests,
  resetSyncSettingsForTests,
  restore as restoreSyncSettings,
  setDestinationEnabled,
} from "./syncSettings";
import {
  arbStoredRecord,
  arbStoredRecords,
  toWireLike,
  type SyncStoredRecord,
} from "./test/arbitraries";

// ---------------------------------------------------------------------------
// Fixtures the assertions are written against
// ---------------------------------------------------------------------------

/** The cursor already stored before the cycle runs — Req 7.5's "last committed". */
const SEEDED_CURSOR = formatCursor(1, 100);
/** The last-successful-sync timestamp Requirement 4.5 keeps unchanged. */
const SEEDED_LAST_SYNC = 1_700_000_000_000;
/** The skipped count that rides with it (Req 20.5), likewise unchanged. */
const SEEDED_LAST_SKIPPED = 3;

/** The cursor a served pull page hands back for page `index`. */
const pageCursor = (index: number): string => formatCursor(1, 200 + index * 100);

// ---------------------------------------------------------------------------
// Raw store access, so seeding and inspection never go through the code paths
// under test
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

/** Empty every store, so each property run sees only its own records. */
async function resetStores(): Promise<void> {
  const db = await rawDb();
  const tx = db.transaction(["events", "outbox", "meta"], "readwrite");
  tx.objectStore("events").clear();
  tx.objectStore("outbox").clear();
  tx.objectStore("meta").clear();
  await txDone(tx);
}

/** Write locally originated records straight into `events`. */
async function seedRecords(records: StoredRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await rawDb();
  const tx = db.transaction("events", "readwrite");
  const store = tx.objectStore("events");
  for (const record of records) store.put(record);
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// Byte-for-byte record comparison (Req 4.4)
// ---------------------------------------------------------------------------

/** JSON with object keys sorted, so the string depends on values only. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  return `{${parts.join(",")}}`;
}

/**
 * A record as a comparable string, Photo bytes included. Requirement 4.4 says
 * "byte-for-byte unchanged", so the Photo is compared by its actual bytes and
 * MIME type rather than by identity — the store hands back a fresh Blob.
 */
async function describeRecord(record: StoredRecord): Promise<string> {
  const src = record as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key !== "photo") fields[key] = value;
  }
  let photo = "none";
  const blob = src.photo as NodeBlob | undefined;
  if (blob !== undefined) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    photo = `${blob.type}/${blob.size}/${Array.from(bytes).join(",")}`;
  }
  return `${stableStringify(fields)}|photo=${photo}`;
}

/** Every stored record, keyed by id, as comparable strings. */
async function snapshotStore(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const record of await getAllRecords()) {
    out.set(record.id, await describeRecord(record));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The injected failure points
// ---------------------------------------------------------------------------

type FailurePoint =
  | { kind: "transport" }
  | { kind: "timeout" }
  | { kind: "server-error" }
  | { kind: "rate-limited" }
  | { kind: "unauthorized" }
  | { kind: "unreadable-body" }
  | { kind: "rejected"; status: 400 | 409 | 413 };

const arbFailurePoint: fc.Arbitrary<FailurePoint> = fc.oneof(
  fc.constant<FailurePoint>({ kind: "transport" }),
  fc.constant<FailurePoint>({ kind: "timeout" }),
  fc.constant<FailurePoint>({ kind: "server-error" }),
  fc.constant<FailurePoint>({ kind: "rate-limited" }),
  fc.constant<FailurePoint>({ kind: "unauthorized" }),
  fc.constant<FailurePoint>({ kind: "unreadable-body" }),
  fc.constant<FailurePoint>({ kind: "rejected", status: 400 }),
  fc.constant<FailurePoint>({ kind: "rejected", status: 409 }),
  fc.constant<FailurePoint>({ kind: "rejected", status: 413 }),
);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null } as unknown as Headers,
    json: async () => body,
  } as unknown as Response;
}

/** A 200 whose body is not a JSON object — `syncRequest` reads it as a failure. */
function unreadableResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null } as unknown as Headers,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  } as unknown as Response;
}

/**
 * The body a payload answer carries. A 400 names the ids permanently
 * (`invalid_record`, Req 19.9), so those ids are settled and leave the Outbox; a
 * 409 names them as `record_cap`, which keeps them queued (Req 19.11); a 413
 * names none at all.
 */
function rejectionBody(status: 400 | 409 | 413, ids: string[]): Record<string, unknown> {
  if (status === 413) return { error: "payload_too_large" };
  const reason = status === 400 ? "invalid_record" : "record_cap";
  return {
    error: reason,
    outcomes: ids.map((id) => ({ id, outcome: "rejected", reason })),
  };
}

/** Ids a failure response settles permanently, so the caller can expect them gone. */
function settledByFailure(point: FailurePoint, ids: string[]): string[] {
  return point.kind === "rejected" && point.status === 400 ? ids : [];
}

function failureResponse(point: FailurePoint, ids: string[]): Promise<Response> {
  switch (point.kind) {
    case "transport":
      return Promise.reject(new TypeError("Failed to fetch"));
    case "timeout":
      // Exactly what `fetchWithTimeout` throws when its 30 s abort fires.
      return Promise.reject(new Error(SYNC_TIMEOUT_MESSAGE));
    case "server-error":
      return Promise.resolve(jsonResponse(503, { error: "server_error" }));
    case "rate-limited":
      return Promise.resolve(jsonResponse(429, { error: "rate_limited", retryAfterSeconds: 30 }));
    case "unauthorized":
      return Promise.resolve(jsonResponse(401, { error: "unauthorized" }));
    case "unreadable-body":
      return Promise.resolve(unreadableResponse());
    case "rejected":
      return Promise.resolve(jsonResponse(point.status, rejectionBody(point.status, ids)));
  }
}

// ---------------------------------------------------------------------------
// The emulated Sync_Service
// ---------------------------------------------------------------------------

/** What the stub actually served, which is what the expectations are built from. */
interface ServiceLog {
  /** Ids the Sync_Service reported as settled, so they may leave the Outbox. */
  settled: string[];
  /** Wire records handed back by pages whose merge transaction committed. */
  committed: unknown[][];
}

interface ServiceScript {
  /** Which phase the failure is injected into. */
  phase: "push" | "pull";
  failure: FailurePoint;
  /** Pull pages served successfully before the failure (Req 7.5). */
  committedPages: number;
  /** Records for each served page. */
  pages: SyncStoredRecord[][];
}

/**
 * Emulate the Sync_Service, failing at the scripted point.
 *
 * `POST /api/sync/push` → 200 `{ outcomes, highestSequence }`.
 * `GET /api/sync/pull` → 200 `{ records, cursor, hasMore }`.
 */
function installFetch(script: ServiceScript): ServiceLog {
  const log: ServiceLog = { settled: [], committed: [] };
  let pushes = 0;
  let pulls = 0;
  let sequence = 200;

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.startsWith(PUSH_PATH)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { records?: { id: string }[] };
        const ids = (body.records ?? []).map((r) => r.id);
        const index = pushes++;
        if (script.phase === "push" && index === 0) {
          log.settled.push(...settledByFailure(script.failure, ids));
          return failureResponse(script.failure, ids);
        }
        log.settled.push(...ids);
        sequence += ids.length;
        return Promise.resolve(
          jsonResponse(200, {
            outcomes: ids.map((id) => ({ id, outcome: "stored" })),
            highestSequence: ids.length > 0 ? sequence : null,
          }),
        );
      }

      if (url.startsWith(PULL_PATH)) {
        const index = pulls++;
        if (index >= script.committedPages) return failureResponse(script.failure, []);
        const records = (script.pages[index] ?? []).map(toWireLike);
        log.committed.push(records);
        return Promise.resolve(
          jsonResponse(200, {
            records,
            cursor: pageCursor(index),
            // Always more, so the loop reaches the scripted failure.
            hasMore: true,
          }),
        );
      }

      throw new Error(`unexpected request: ${url}`);
    }),
  );

  return log;
}

// ---------------------------------------------------------------------------
// Per-run setup
// ---------------------------------------------------------------------------

/** Photo bytes that survive `structuredClone`; see the header note. */
function nodePhoto(seed: string): Blob {
  const bytes = Uint8Array.from([...seed].slice(0, 8).map((c) => c.charCodeAt(0) & 0xff));
  return new NodeBlob([bytes], { type: "image/jpeg" }) as unknown as Blob;
}

/**
 * Give every generated record a unique id and a storable photo. Generated
 * photos are jsdom Blobs, which `structuredClone` flattens, so they are swapped
 * for Node Blobs carrying real bytes.
 */
function localize(records: SyncStoredRecord[]): StoredRecord[] {
  return records.map((record, i) => {
    const id = `local-${i}`;
    const src = record as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { ...src, id };
    if (src.photo !== undefined) out.photo = nodePhoto(id);
    return out as unknown as StoredRecord;
  });
}

/** Pulled records, on ids no local record holds. */
function remotize(pages: SyncStoredRecord[][]): SyncStoredRecord[][] {
  return pages.map((page, p) =>
    page.map((record, i) => {
      const src = record as unknown as Record<string, unknown>;
      const out: Record<string, unknown> = { ...src, id: `remote-${p}-${i}` };
      // A Photo is on-device-only data; it never travels on the wire.
      delete out.photo;
      return out as unknown as SyncStoredRecord;
    }),
  );
}

/**
 * A signed-in, Cloud-enabled device holding `records` locally, with `queued` in
 * the Outbox and a cursor and last-sync timestamp already stored.
 */
async function setUpDevice(records: StoredRecord[], queued: string[]): Promise<void> {
  await resetStores();
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();

  setToken("session-token-for-tests");
  await restoreSyncSettings();
  setDestinationEnabled("cloud", true);

  await seedRecords(records);
  await enqueueIds(queued, { now: 1_000 });
  await setMeta("cursor", SEEDED_CURSOR);
  await setMeta("lastSyncAt", SEEDED_LAST_SYNC);
  await setMeta("lastSkipped", SEEDED_LAST_SKIPPED);

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
// Property 20
// ---------------------------------------------------------------------------

interface Scenario {
  local: SyncStoredRecord[];
  /** Outbox ids the Local_Store holds no record for (Req 6.1's drop path). */
  unmatched: number;
  phase: "push" | "pull";
  failure: FailurePoint;
  committedPages: number;
  pages: SyncStoredRecord[][];
}

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  // At least one record, so a push phase always has a batch to fail on.
  local: fc
    .tuple(arbStoredRecord, arbStoredRecords)
    .map(([first, rest]) => [first, ...rest].slice(0, 12)),
  unmatched: fc.integer({ min: 0, max: 2 }),
  phase: fc.constantFrom<"push" | "pull">("push", "pull"),
  failure: arbFailurePoint,
  // 0 = the first page fails; 1–2 = pages commit before the failure.
  committedPages: fc.integer({ min: 0, max: 2 }),
  pages: fc.array(fc.array(arbStoredRecord, { maxLength: 4 }), { minLength: 3, maxLength: 3 }),
});

describe("Property 20: failure preserves local data, the cursor, and the last-sync timestamp", () => {
  it("leaves local records, the cursor, the last-sync timestamp, and unsettled Outbox ids intact", async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const local = localize(scenario.local);
        const unmatchedIds = Array.from(
          { length: scenario.unmatched },
          (_, i) => `missing-${i}`,
        );
        const queued = [...local.map((r) => r.id), ...unmatchedIds];

        await setUpDevice(local, queued);
        const before = await snapshotStore();

        const log = installFetch({
          phase: scenario.phase,
          failure: scenario.failure,
          committedPages: scenario.phase === "pull" ? scenario.committedPages : 0,
          pages: remotize(scenario.pages),
        });

        const result =
          scenario.phase === "push" ? await runPushPhase() : await runPullPhase();

        // The phase did not complete, and it says why.
        expect(result.status).not.toBe("complete");
        expect(result.failure).not.toBeNull();

        // ---- Req 4.4, local half: every locally originated record unchanged.
        const after = await snapshotStore();
        for (const record of local) {
          expect(after.get(record.id)).toBe(before.get(record.id));
        }

        // ---- Req 4.4, pull half: every record a committed page merged is retained.
        const expectedMerged = new Map<string, string>();
        for (const page of log.committed) {
          for (const wire of page) {
            const parsed = fromEventRecord(wire);
            if (parsed === null) continue; // skipped, never merged (Req 20.3)
            expectedMerged.set(parsed.id, await describeRecord(parsed));
          }
        }
        for (const [id, expected] of expectedMerged) {
          expect(after.get(id)).toBe(expected);
        }
        // Nothing else landed: no half-merged page, no resurrected record.
        expect(after.size).toBe(local.length + expectedMerged.size);

        // ---- Req 7.5: the cursor is exactly what the last committed page set.
        const committed = log.committed.length;
        const expectedCursor =
          committed === 0 ? SEEDED_CURSOR : pageCursor(committed - 1);
        expect(await getMeta<string>("cursor")).toBe(expectedCursor);

        // ---- Req 4.5: the persisted last-sync timestamp is unchanged.
        expect(await getMeta<number>("lastSyncAt")).toBe(SEEDED_LAST_SYNC);
        expect(await getMeta<number>("lastSkipped")).toBe(SEEDED_LAST_SKIPPED);
        const state = getSyncState();
        expect(state.state).not.toBe("synced");
        if ("lastSyncAt" in state) expect(state.lastSyncAt).toBe(SEEDED_LAST_SYNC);

        // ---- Req 6.8: every id that was not settled is still queued.
        const settled = new Set([...unmatchedIds, ...log.settled]);
        const expectedQueued =
          scenario.phase === "push" ? queued.filter((id) => !settled.has(id)) : queued;
        expect((await getOutboxBatch(10_000)).sort()).toEqual([...expectedQueued].sort());
      }),
      { numRuns: 120 },
    );
  });
});

// ---------------------------------------------------------------------------
// The multi-batch push case, which the property's ≤12 records cannot reach:
// `planPush` packs 200 records per request, so a second batch needs more
// records than a property run should write.
// ---------------------------------------------------------------------------

describe("a failed second push batch (Req 6.8)", () => {
  it("keeps every id the failing request carried, and settles only the first batch", async () => {
    const records: StoredRecord[] = Array.from({ length: 250 }, (_, i) => ({
      id: `bulk-${String(i).padStart(3, "0")}`,
      type: "meal" as const,
      createdAt: 1_000 + i,
      // Ascending, so `planPush`'s ordering matches the id order.
      updatedAt: 1_000 + i,
      dish: "oatmeal",
      ingredients: [{ name: "oats", confidence: "confident" as const }],
    }));
    const ids = records.map((r) => r.id);

    await setUpDevice(records, ids);
    const before = await snapshotStore();

    // Fail the second request only.
    let pushes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input).startsWith(PUSH_PATH)).toBe(true);
        const body = JSON.parse(String(init?.body ?? "{}")) as { records: { id: string }[] };
        if (pushes++ === 1) return Promise.resolve(jsonResponse(503, { error: "server_error" }));
        return Promise.resolve(
          jsonResponse(200, {
            outcomes: body.records.map((r) => ({ id: r.id, outcome: "stored" })),
            highestSequence: body.records.length,
          }),
        );
      }),
    );

    const result = await runPushPhase();

    expect(result.status).toBe("failed");
    expect(result.requests).toBe(1); // the failed request issued nothing further
    expect(await getOutboxBatch(10_000)).toEqual(ids.slice(200));

    // Every Log_Event is untouched, and so are the cursor and the timestamp.
    expect(await snapshotStore()).toEqual(before);
    expect(await getMeta<string>("cursor")).toBe(SEEDED_CURSOR);
    expect(await getMeta<number>("lastSyncAt")).toBe(SEEDED_LAST_SYNC);
    const state = getSyncState();
    expect(state.state).toBe("error");
  });
});
