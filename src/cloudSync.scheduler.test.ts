// Feature: cloud-sync, Property 18: At most one cycle runs, with at most one
// queued rerun
//
// Validates: Requirements 11.5, 11.6, 11.8, 11.10
//
// The scheduler under test is `requestSync` — the eligibility gate, the
// single-flight beneath it, and the re-gated cycle body — so the Sync_Cycle it
// admits is a real one: `fake-indexeddb/auto` gives the phases a store whose
// transactions actually commit, and the Sync_Service is emulated by stubbing
// global `fetch`, the seam `fetchWithTimeout` calls.
//
// A concurrency property needs an observable for "this cycle body is inside its
// phases", and the honest one here is "its sync request is still outstanding".
// The stub therefore **parks** every pull: a cycle that has issued its pull sits
// inside `runPullPhase` until the test releases it, which makes "two cycles never
// overlap in time" a checkable state rather than a race the test hopes to lose.
// With an empty Outbox the push phase issues zero requests (Req 6.12), so one
// cycle is exactly one pull request and counting pull requests counts cycle
// bodies.
//
// Expectations come from a reference model of Requirement 11.5 — running, queued,
// and the Requirement 11.11 floor that gates `auto-retry` — evaluated in lockstep
// with the real scheduler after every scheduled step. Timers stay real and
// `startTriggers()` is deliberately never installed, so nothing but the schedule
// can start a cycle; the clock the gate reads is mocked directly, and the
// schedule's `advance` steps move it.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  PULL_PATH,
  PUSH_PATH,
  formatCursor,
  getSyncState,
  hydrateSyncState,
  requestSync,
  resetCloudSyncForTests,
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

// Stub for removed entitlement function — tests will be cleaned up in task 1.8/1.9
function applyEntitlement(_e: { pro: boolean; proUntil: number | null }): void {}
import {
  TRIGGER_REASONS,
  arbTriggerSchedule,
  type TriggerReasonLike,
  type TriggerSchedule,
} from "./test/arbitraries";

/** A spy handle, kept structural so the tests do not name Vitest's mock types. */
type Restorable = { mockRestore: () => void };

const PRO_ENTITLEMENT = { pro: true, proUntil: null };
const NO_PRO_ENTITLEMENT = { pro: false, proUntil: null };

/** Requirement 11.11's floor between successive automatic retries. */
const AUTO_RETRY_FLOOR_MS = 60_000;

/** The mocked clock's origin; `advance` steps move the offset, never this. */
const CLOCK_BASE = 1_700_000_000_000;

/** The cursor already stored before a cycle runs (Req 11.10's "unchanged"). */
const SEEDED_CURSOR = formatCursor(1, 100);

// ---------------------------------------------------------------------------
// The mocked clock
// ---------------------------------------------------------------------------

let clockOffset = 0;
let clockSpy: Restorable | null = null;

function installClock(): void {
  clockOffset = 0;
  clockSpy = vi.spyOn(Date, "now").mockImplementation(() => CLOCK_BASE + clockOffset);
}

/** The value the scheduler's gate reads from the clock right now. */
function now(): number {
  return CLOCK_BASE + clockOffset;
}

// ---------------------------------------------------------------------------
// Raw store access, so seeding and inspection never go through the scheduler
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

/** Empty every store, so each property run sees only its own state. */
async function resetStores(): Promise<void> {
  const db = await rawDb();
  const tx = db.transaction(["events", "outbox", "meta"], "readwrite");
  tx.objectStore("events").clear();
  tx.objectStore("outbox").clear();
  tx.objectStore("meta").clear();
  await txDone(tx);
}

async function seedRecords(records: StoredRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await rawDb();
  const tx = db.transaction("events", "readwrite");
  for (const record of records) tx.objectStore("events").put(record);
  await txDone(tx);
}

/** Two plain check-ins, so a seeded Outbox id always has a record to send. */
function localRecords(): StoredRecord[] {
  return [
    {
      id: "local-1",
      type: "checkin",
      createdAt: CLOCK_BASE - 2_000,
      updatedAt: CLOCK_BASE - 2_000,
      stress: "low",
    },
    {
      id: "local-2",
      type: "checkin",
      createdAt: CLOCK_BASE - 1_000,
      updatedAt: CLOCK_BASE - 1_000,
      stress: "high",
    },
  ] as StoredRecord[];
}

// ---------------------------------------------------------------------------
// Letting the event loop run
//
// fake-indexeddb schedules its transaction steps with `setImmediate`, so ticking
// the immediate queue is what lets a cycle progress from `requestSync` to its
// pull request and from a released response to its next state. A generous fixed
// number of ticks per scheduled step keeps every assertion below a statement
// about a settled scheduler rather than a race.
// ---------------------------------------------------------------------------

function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    const immediate = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate;
    if (immediate) immediate(resolve);
    else setTimeout(resolve, 0);
  });
}

async function flush(ticks = 40): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await tick();
}

// ---------------------------------------------------------------------------
// The emulated Sync_Service, with a parked pull
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null } as unknown as Headers,
    json: async () => body,
  } as unknown as Response;
}

interface ServiceOptions {
  /** How the push answers every id it is sent. */
  push?: "stored" | "record_cap";
  /** Wire records each released pull page carries. */
  pullRecords?: unknown[];
  /** Whether a released page reports further records. */
  pullHasMore?: boolean;
}

/** What the stub saw, plus the handles that release parked cycles. */
interface Service {
  /** Pull requests issued — one per cycle body that reached its pull. */
  pulls: number;
  /** Push requests issued. */
  pushes: number;
  /** The high-water mark of concurrently outstanding sync requests. */
  maxOutstanding: number;
  /** Requests the stub did not expect; every test asserts this stays empty. */
  unexpected: string[];
  /** Pull requests parked awaiting a response. */
  parked: ((res: Response) => void)[];
  /**
   * The entitlement every answer carries. Mutable because the transport funnels
   * it into `syncSettings`, so a Pro_Lapse has to be visible in what the
   * Sync_Service says as well as in the local snapshot.
   */
  entitlement: { pro: boolean; proUntil: number | null };
  /** Release the oldest parked pull; false when none is parked. */
  release: (outcome: "success" | "failure") => boolean;
}

function installFetch(options: ServiceOptions = {}): Service {
  let outstanding = 0;
  let sequence = 200;

  const service: Service = {
    pulls: 0,
    pushes: 0,
    maxOutstanding: 0,
    unexpected: [],
    parked: [],
    entitlement: PRO_ENTITLEMENT,
    release: (outcome) => {
      const parked = service.parked.shift();
      if (!parked) return false;
      sequence += 100;
      parked(
        outcome === "success"
          ? jsonResponse(200, {
              records: options.pullRecords ?? [],
              cursor: formatCursor(1, sequence),
              hasMore: options.pullHasMore ?? false,
              entitlement: service.entitlement,
            })
          : jsonResponse(503, { error: "server_error" }),
      );
      return true;
    },
  };

  /** One request enters flight; the high-water mark is what the property reads. */
  const enter = (): void => {
    outstanding += 1;
    service.maxOutstanding = Math.max(service.maxOutstanding, outstanding);
  };

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.startsWith(PUSH_PATH)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { records?: { id: string }[] };
        const ids = (body.records ?? []).map((r) => r.id);
        service.pushes += 1;
        // Answered immediately, so its window closes at once; it still counts
        // towards the high-water mark, which is how a push issued by a second
        // cycle while the first is parked would be caught.
        enter();
        outstanding -= 1;
        const outcomes =
          options.push === "record_cap"
            ? ids.map((id) => ({ id, outcome: "rejected", reason: "record_cap" }))
            : ids.map((id) => ({ id, outcome: "stored" }));
        return Promise.resolve(
          jsonResponse(200, {
            outcomes,
            highestSequence: null,
            entitlement: service.entitlement,
          }),
        );
      }

      if (url.startsWith(PULL_PATH)) {
        service.pulls += 1;
        enter();
        return new Promise<Response>((resolve) => {
          service.parked.push((res) => {
            outstanding -= 1;
            resolve(res);
          });
        });
      }

      service.unexpected.push(url);
      return Promise.resolve(jsonResponse(503, { error: "server_error" }));
    }),
  );

  return service;
}

// ---------------------------------------------------------------------------
// A signed-in, Pro, Cloud-enabled device
// ---------------------------------------------------------------------------

interface DeviceOptions {
  /** Ids to seed into the Outbox. */
  queued?: string[];
  /** Whether to seed the Sync_Cursor. */
  cursor?: boolean;
}

async function setUpDevice(options: DeviceOptions = {}): Promise<void> {
  await resetStores();
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();

  setToken("session-token-for-tests");
  await restoreSyncSettings();
  setDestinationEnabled("cloud", true);

  await seedRecords(localRecords());
  if (options.queued && options.queued.length > 0) {
    await enqueueIds(options.queued, { now: CLOCK_BASE - 5_000 });
  }
  if (options.cursor) await setMeta("cursor", SEEDED_CURSOR);
  await hydrateSyncState();
}

async function tearDownDevice(): Promise<void> {
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  clearToken();
}

beforeEach(() => {
  clearToken();
  installClock();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  clockSpy?.mockRestore();
  clockSpy = null;
  await tearDownDevice();
});

// ---------------------------------------------------------------------------
// The reference model of Requirement 11.5
// ---------------------------------------------------------------------------

interface Model {
  /** A cycle body is inside its phases. */
  running: boolean;
  /** The one queued rerun (Req 11.5), which no further trigger can duplicate. */
  queued: boolean;
  /** When the most recent failed cycle ended, for the Req 11.11 floor. */
  lastFailureEndedAt: number | null;
  /** Cycle bodies that have run. */
  cycles: number;
}

function newModel(): Model {
  return { running: false, queued: false, lastFailureEndedAt: null, cycles: 0 };
}

function modelTrigger(model: Model, reason: TriggerReasonLike, at: number): void {
  // Req 11.11 — the retry timer's own trigger is the only one the floor gates,
  // and no Requirement 19.8 wait is outstanding in this scenario.
  const floored =
    reason === "auto-retry" &&
    model.lastFailureEndedAt !== null &&
    at < model.lastFailureEndedAt + AUTO_RETRY_FLOOR_MS;
  if (floored) return;

  // Req 11.5 — any number of triggers during a cycle collapse into one rerun.
  if (model.running) {
    model.queued = true;
    return;
  }
  model.running = true;
  model.cycles += 1;
}

function modelFinish(model: Model, outcome: "success" | "failure", at: number): void {
  if (!model.running) return;
  model.running = false;
  model.lastFailureEndedAt = outcome === "failure" ? at : null;
  // Req 11.5 — the queued cycle runs whether this one succeeded or failed.
  if (model.queued) {
    model.queued = false;
    model.running = true;
    model.cycles += 1;
  }
}

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

describe("requestSync (Property 18: at most one cycle runs, with at most one queued rerun)", () => {
  it("never overlaps two cycles and collapses any burst into one queued rerun", async () => {
    await fc.assert(
      fc.asyncProperty(arbTriggerSchedule, async (schedule: TriggerSchedule) => {
        await setUpDevice();
        const service = installFetch();
        const model = newModel();
        const pending: Promise<void>[] = [];

        try {
          for (const step of schedule.steps) {
            switch (step.kind) {
              case "trigger":
                pending.push(requestSync(step.reason));
                modelTrigger(model, step.reason, now());
                break;
              case "finishCycle":
                if (service.release(step.outcome)) modelFinish(model, step.outcome, now());
                break;
              case "advance":
                clockOffset += step.ms;
                break;
              case "settle":
                break;
            }
            await flush();

            // Req 11.5 — exactly one cycle body sits inside its phases when the
            // model says one is running, and none otherwise. A second concurrent
            // cycle would show up here as a second parked pull.
            expect(service.parked.length).toBe(model.running ? 1 : 0);
            expect(service.pulls).toBe(model.cycles);
          }

          // Drain whatever the schedule left in flight so no cycle outlives the
          // run, releasing the one rerun each completion may start.
          for (let i = 0; i < 8 && service.parked.length > 0; i += 1) {
            service.release("success");
            await flush();
          }
          await Promise.all(pending);

          expect(service.unexpected).toEqual([]);
          // An empty Outbox sends nothing (Req 6.12), so every request was a pull.
          expect(service.pushes).toBe(0);
          // Two cycle bodies never had a request outstanding at the same instant.
          expect(service.maxOutstanding).toBeLessThanOrEqual(1);
        } finally {
          await tearDownDevice();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("queues zero cycles and issues zero requests while ineligible", async () => {
    const arbCause = fc.constantFrom(
      "disabled" as const,
      "no-session" as const,
      "offline" as const,
    );
    const arbTriggers = fc.array(fc.constantFrom(...TRIGGER_REASONS), {
      minLength: 1,
      maxLength: 8,
    });

    await fc.assert(
      fc.asyncProperty(arbCause, arbTriggers, async (cause, reasons) => {
        await setUpDevice({ queued: ["local-1", "local-2"], cursor: true });
        const service = installFetch();
        let onLine: Restorable | null = null;

        try {
          // Req 11.6, 11.8 — one of the four conditions that makes every trigger
          // a no-op.
          if (cause === "disabled") setDestinationEnabled("cloud", false);
          if (cause === "no-session") clearToken();
          if (cause === "offline") {
            onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
          }

          await Promise.all(reasons.map((reason) => requestSync(reason)));
          await flush();

          // Zero requests to the Sync_Service, and no cycle queued behind them.
          expect(service.pulls).toBe(0);
          expect(service.pushes).toBe(0);
          expect(service.unexpected).toEqual([]);
          expect(service.parked).toEqual([]);
          expect(getSyncState().state).not.toBe("syncing");

          // Req 11.8 — the Outbox and the Sync_Cursor are untouched.
          expect([...(await getOutboxBatch(10))].sort()).toEqual(["local-1", "local-2"]);
          expect(await getMeta("cursor")).toBe(SEEDED_CURSOR);

          if (cause === "offline") {
            const state = getSyncState();
            expect(state.state).toBe("error");
            if (state.state === "error") expect(state.kind).toBe("offline");
          }
        } finally {
          onLine?.mockRestore();
          await tearDownDevice();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("discards the queued rerun when the destination stopped being usable", async () => {
    const arbCause = fc.constantFrom("disabled" as const, "no-session" as const);
    const arbBurst = fc.integer({ min: 1, max: 5 });

    await fc.assert(
      fc.asyncProperty(arbCause, arbBurst, async (cause, burst) => {
        await setUpDevice({ queued: ["local-1", "local-2"], cursor: true });
        // The push keeps both ids queued (`record_cap`, Req 19.11), so the Outbox
        // this property says is retained is a non-empty one, and the parked page
        // carries a record that must not be merged.
        const service = installFetch({
          push: "record_cap",
          pullHasMore: true,
          pullRecords: [
            {
              id: "remote-1",
              type: "checkin",
              schemaVersion: 2,
              createdAt: CLOCK_BASE,
              updatedAt: CLOCK_BASE,
              stress: "low",
            },
          ],
        });
        const pending: Promise<void>[] = [];

        try {
          pending.push(requestSync("manual"));
          await flush();
          // The cycle is parked inside its pull, having pushed once.
          expect(service.pushes).toBe(1);
          expect(service.parked.length).toBe(1);

          // A burst of eligible triggers collapses into the one queued rerun.
          for (let i = 0; i < burst; i += 1) pending.push(requestSync("local-write"));
          await flush();
          expect(service.pulls).toBe(1);

          // Req 11.10 — the destination stops being usable before the rerun runs.
          if (cause === "disabled") setDestinationEnabled("cloud", false);
          if (cause === "no-session") clearToken();

          service.release("success");
          await flush();
          await Promise.all(pending);

          // The queued cycle was discarded: no second pull, no further push.
          expect(service.pulls).toBe(1);
          expect(service.pushes).toBe(1);
          expect(service.parked).toEqual([]);
          expect(service.unexpected).toEqual([]);
          expect(service.maxOutstanding).toBeLessThanOrEqual(1);

          // Req 11.10 — the Outbox, the Sync_Cursor, and the Local_Store are
          // unchanged, and the page fetched before the flip was never merged.
          expect([...(await getOutboxBatch(10))].sort()).toEqual(["local-1", "local-2"]);
          expect(await getMeta("cursor")).toBe(SEEDED_CURSOR);
          expect(
            (await getAllRecords()).map((r) => r.id).sort(),
          ).toEqual(["local-1", "local-2"]);
        } finally {
          await tearDownDevice();
        }
      }),
      { numRuns: 100 },
    );
  });
});
