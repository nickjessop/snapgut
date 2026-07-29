import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";

// Feature: google-sheets-integration, Property 7: Sync failure preserves local data and last-sync timestamp
//
// For any list of LogEvents and any injected write/read failure point, after
// `syncAll` rejects, the local IndexedDB event set is unchanged and the stored
// last-sync timestamp is unchanged (no completion timestamp is recorded for the
// failed operation).
//
// Validates: Requirements 4.8, 10.1, 10.5

// ---- Fake IndexedDB ----
//
// `vi.mock` is hoisted above the imports, so the backing store is created with
// `vi.hoisted` and shared with the factory below. Everything else in `db.ts`
// (types, `toCSV`, helpers) is re-exported from the real module so the rest of
// the import graph keeps working.
const h = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getEvents: async () => [...h.store.values()],
    putEvent: async (e: { id: string }) => {
      h.store.set(e.id, e);
    },
    deleteEvent: async (id: string) => {
      h.store.delete(id);
    },
  };
});

// A spreadsheet row carries no Revision_Time, so these fixtures and the row
// mapping work over `DraftEvent` — a log event without the `updatedAt` that
// `putEvent` assigns on the way into the Local_Store.
import type { DraftEvent } from "./db";
import { SYMPTOMS } from "./symptoms";
import {
  syncAll,
  getLastSyncAt,
  setLastSyncAt,
  setSpreadsheetId,
  getStatus,
  setRuntime,
  resetGisForTests,
  SHEET_HEADER,
} from "./googleSheets";

// ---- Injected failure points ----
//
// Every point makes the sync fail, but at a different stage of `syncBody`:
//   "offline" — navigator.onLine === false → no Google API request at all
//   "token"   — the silent GIS token request is denied → no Google API request
//   "read"    — GET .../values/Log fails (500)
//   "update"  — POST .../values:batchUpdate fails (500)
//   "append"  — POST .../values/Log:append fails (500)
type Injection = "offline" | "token" | "read" | "update" | "append";

const INJECTIONS: Injection[] = ["offline", "token", "read", "update", "append"];

/** Prior successful-sync timestamp that must survive every failure (Req 10.5). */
const PRIOR_SYNC_AT = 12345;

// ---- Generators ----

const arbSeverity = fc.constantFrom("mild" as const, "moderate" as const, "severe" as const);
const arbSymptomId = fc.constantFrom(...SYMPTOMS.map((s) => s.id));
const arbLoggedSymptom = fc.record({ id: arbSymptomId, severity: arbSeverity });
const arbText = fc.string({ maxLength: 24 });
const arbCreatedAt = fc.integer({ min: 0, max: 4102444800000 });
const arbId = fc.uuid();

const arbMeal: fc.Arbitrary<DraftEvent> = fc.record({
  type: fc.constant("meal" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: fc.option(arbText, { nil: undefined }),
  dish: arbText,
  ingredients: fc.array(
    fc.record({
      name: arbText,
      confidence: fc.constantFrom("confident" as const, "maybe" as const),
    }),
    { maxLength: 4 },
  ),
});

const arbSymptom: fc.Arbitrary<DraftEvent> = fc.record({
  type: fc.constant("symptom" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: fc.option(arbText, { nil: undefined }),
  symptoms: fc.array(arbLoggedSymptom, { maxLength: 3 }),
});

const arbBowel: fc.Arbitrary<DraftEvent> = fc.record({
  type: fc.constant("bowel" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: fc.option(arbText, { nil: undefined }),
  bristol: fc.integer({ min: 1, max: 7 }),
  symptoms: fc.option(fc.array(arbLoggedSymptom, { minLength: 1, maxLength: 3 }), {
    nil: undefined,
  }),
});

const arbCheckin: fc.Arbitrary<DraftEvent> = fc.record({
  type: fc.constant("checkin" as const),
  id: arbId,
  createdAt: arbCreatedAt,
  note: fc.option(arbText, { nil: undefined }),
  stress: fc.option(fc.constantFrom("low" as const, "medium" as const, "high" as const), {
    nil: undefined,
  }),
  sleep: fc.option(fc.constantFrom("poor" as const, "ok" as const, "good" as const), {
    nil: undefined,
  }),
});

const arbLogEvent: fc.Arbitrary<DraftEvent> = fc.oneof(arbMeal, arbSymptom, arbBowel, arbCheckin);

// At least one event so the "update"/"append" injection points are actually
// reached (both writes are no-ops for an empty plan).
const arbEvents: fc.Arbitrary<DraftEvent[]> = fc.array(arbLogEvent, { minLength: 1, maxLength: 5 });

// ---- Mocked GIS + fetch ----

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

type Client = {
  callback: (r: TokenResponse) => void;
  requestAccessToken: (opts?: { prompt?: string }) => void;
};

let client: Client;
let grantToken: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

function installGis(): void {
  client = {
    callback: () => {},
    requestAccessToken: () => {
      if (grantToken) {
        client.callback({ access_token: "token-abc", expires_in: 3600 });
      } else {
        client.callback({ error: "access_denied" });
      }
    },
  };
  (globalThis as unknown as { google: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient: () => client,
        revoke: (_t: string, done?: () => void) => done && done(),
      },
    },
  };
}

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

function fail(): Response {
  return {
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    json: async () => ({}),
  } as unknown as Response;
}

/**
 * Route the Sheets REST calls, failing exactly at `point`.
 *
 * For the "update" point the read returns a sheet already containing every
 * event id (so the plan is all updates); for every other point the read returns
 * just the header row (so the plan is all appends).
 */
function installFetch(point: Injection, events: DraftEvent[]): void {
  const dataRows =
    point === "update"
      ? events.map((e) => ["", "", "", "", "", "", "", "", "", "", e.id])
      : [];

  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("values:batchUpdate")) {
      return point === "update" ? fail() : ok({});
    }
    if (url.includes(":append")) {
      return point === "append" ? fail() : ok({});
    }
    if (url.includes("/values/")) {
      return point === "read" ? fail() : ok({ values: [[...SHEET_HEADER], ...dataRows] });
    }
    return ok({});
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Force `navigator.onLine` for the offline injection point (Req 10.2). */
function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
}

beforeEach(() => {
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetGisForTests();
  setRuntime({ phase: "idle" });
  localStorage.clear();
  h.store.clear();
  setOnLine(true);
  delete (globalThis as unknown as { google?: unknown }).google;
});

describe("syncAll failure (Property 7: sync failure preserves local data and last-sync timestamp)", () => {
  it("leaves the local event set and the last-sync timestamp unchanged for any injected failure point", async () => {
    await fc.assert(
      fc.asyncProperty(arbEvents, fc.constantFrom(...INJECTIONS), async (events, point) => {
        // --- arrange: fresh local state for this run ---
        h.store.clear();
        for (const e of events) h.store.set(e.id, e);

        localStorage.clear();
        setSpreadsheetId("sheet-1"); // connected (Req 5.4 guard passes)
        setLastSyncAt(PRIOR_SYNC_AT); // a previous successful sync exists
        setRuntime({ phase: "idle" });

        resetGisForTests(); // drop any cached token so "token" really denies
        grantToken = point !== "token";
        installGis();
        installFetch(point, events);
        setOnLine(point !== "offline");

        // --- snapshot the local-first invariants ---
        const before = structuredClone([...h.store.values()]);
        const tsBefore = getLastSyncAt();
        expect(tsBefore).toBe(PRIOR_SYNC_AT);

        // --- act: every injection point must make the sync fail ---
        await expect(syncAll()).rejects.toThrow();

        // --- assert: local IndexedDB event set unchanged (Req 4.8, 10.1) ---
        const after = [...h.store.values()];
        expect(after).toEqual(before);
        expect(after).toHaveLength(before.length);

        // --- assert: no completion timestamp recorded (Req 4.8, 10.5) ---
        expect(getLastSyncAt()).toBe(tsBefore);

        const status = getStatus();
        expect(status.state).toBe("error");
        if (status.state === "error") expect(status.lastSyncAt).toBe(PRIOR_SYNC_AT);

        // The two pre-flight failures never touch the Google APIs (Req 10.2, 3.3);
        // the REST points must actually have reached the request they fail on, so
        // the failure is injected where the test intends.
        const urls = fetchMock.mock.calls.map((c) => String(c[0]));
        if (point === "offline" || point === "token") {
          expect(urls).toHaveLength(0);
        } else if (point === "read") {
          expect(urls.some((u) => u.includes("/values/") && !u.includes(":append"))).toBe(true);
        } else if (point === "update") {
          expect(urls.some((u) => u.includes("values:batchUpdate"))).toBe(true);
        } else {
          expect(urls.some((u) => u.includes(":append"))).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
