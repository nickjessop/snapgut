import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LogEvent, MealEvent } from "./db";

// Task 13.2 — Integration tests for `reimport` (mocked GIS + `fetch` + `db`).
//
// These exercise `reimport` end-to-end across the I/O shell, asserting the
// outcome-level guarantees:
//   - an existing id is updated in place with the sheet's non-photo values, keeps
//     its local photo, and is never duplicated (Req 9.2)
//   - the imported/skipped counts reported back reflect valid vs malformed rows
//     (Req 9.3, 9.5)
//   - a failed sheet read sets the error status and leaves every local event
//     untouched (Req 9.6)
//   - while disconnected no re-import is initiated at all (Req 9.7)
//
// Validates: Requirements 9.2, 9.5, 9.6, 9.7

// ---- Fake local event store (stands in for IndexedDB) ----
//
// `googleSheets.ts` reads local events through `getEvents` and writes them back
// through `addEvent` (a `put` keyed by id); both are redirected to an in-memory
// map so the tests can seed local state and observe exactly what was written.

const h = vi.hoisted(() => ({ store: new Map<string, LogEvent>() }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getEvents: async () => [...h.store.values()],
    addEvent: async (e: LogEvent) => {
      h.store.set(e.id, e);
    },
  };
});

import { getSymptom } from "./symptoms";
import {
  reimport,
  rowFromEvent,
  getStatus,
  getLastSyncAt,
  setSpreadsheetId,
  clearSpreadsheetId,
  setRuntime,
  resetGisForTests,
  isSheetsConnected,
  SHEET_HEADER,
} from "./googleSheets";

const SPREADSHEET_ID_KEY = "food-snap-sheets-spreadsheet-id";
const LAST_SYNC_KEY = "food-snap-sheets-last-sync";

/** Same symptom-label mapping a real sync uses when writing rows. */
const labelFor = (id: string): string => getSymptom(id)?.label ?? id;

// ---- Mocked GIS surface (silent token grant) ----

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

type Client = {
  callback: (r: TokenResponse) => void;
  requestAccessToken: ReturnType<typeof vi.fn>;
};

let client: Client;

// ---- fetch mock plumbing ----

type Recorded = { url: string; init: RequestInit };

let calls: Recorded[];
let router: (url: string, init: RequestInit) => Response;
let mockFetch: ReturnType<typeof vi.fn>;

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {},
): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    statusText: init.statusText ?? (ok ? "OK" : "Error"),
    json: async () => body,
  } as unknown as Response;
}

function method(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase();
}

/** Serve the given data rows (below the header) for the sheet read. */
function readRouter(dataRows: string[][]): (url: string, init: RequestInit) => Response {
  return (url, init) => {
    if (url.includes("/values/") && method(init) === "GET") {
      return jsonResponse({ values: [[...SHEET_HEADER], ...dataRows] });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };
}

/** Router whose read of the sheet fails with a 500. */
const readFailsRouter = (url: string, init: RequestInit): Response => {
  if (url.includes("/values/") && method(init) === "GET") {
    return jsonResponse({}, { ok: false, status: 500, statusText: "Internal Server Error" });
  }
  throw new Error(`Unexpected fetch to ${url}`);
};

function meal(id: string, dish: string, createdAt = 1_700_000_000_000): MealEvent {
  return {
    id,
    createdAt,
    type: "meal",
    dish,
    ingredients: [{ name: "rice", confidence: "confident" }],
  };
}

beforeEach(() => {
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");

  // Fresh persistence + runtime + local store for every case.
  localStorage.removeItem(SPREADSHEET_ID_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
  h.store.clear();
  resetGisForTests();
  setRuntime({ phase: "idle" });

  // Connected: a stored spreadsheet id defines Connected_State.
  setSpreadsheetId("sheet-1");

  // GIS mock granting a long-lived token silently.
  client = {
    callback: () => {},
    requestAccessToken: vi.fn(() =>
      client.callback({ access_token: "token-abc", expires_in: 3600 }),
    ),
  };
  (globalThis as unknown as { google: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient: vi.fn(() => client),
        revoke: vi.fn((_t: string, done?: () => void) => done && done()),
      },
    },
  };

  calls = [];
  router = readRouter([]);
  mockFetch = vi.fn((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve(router(url, init));
  });
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetGisForTests();
  delete (globalThis as unknown as { google?: unknown }).google;
  localStorage.removeItem(SPREADSHEET_ID_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
  h.store.clear();
  setRuntime({ phase: "idle" });
});

describe("reimport — existing id updated in place, photo retained (Req 9.2)", () => {
  it("overwrites non-photo fields, keeps the local photo, and creates no duplicate", async () => {
    // Local meal with an on-device photo and the OLD dish name.
    const photo = new Blob(["x"]);
    h.store.set("m1", { ...meal("m1", "Old dish"), photo });

    // The sheet holds a NEWER version of the same event (same id, new dish),
    // written exactly the way a sync would have written it.
    router = readRouter([rowFromEvent(meal("m1", "New dish"), labelFor)]);

    const result = await reimport();

    expect(result).toEqual({ imported: 1, skipped: 0 });

    // Same id → updated in place, no duplicate event (Req 9.2).
    expect(h.store.size).toBe(1);

    const stored = h.store.get("m1") as MealEvent;
    expect(stored.type).toBe("meal");
    // Non-photo values come from the sheet.
    expect(stored.dish).toBe("New dish");
    // The local-only photo survives the merge (Req 9.2).
    expect(stored.photo).toBe(photo);
  });

  it("adds an event whose id is not present locally", async () => {
    router = readRouter([rowFromEvent(meal("brand-new", "Pho"), labelFor)]);

    const result = await reimport();

    expect(result).toEqual({ imported: 1, skipped: 0 });
    expect(h.store.size).toBe(1);
    expect((h.store.get("brand-new") as MealEvent).dish).toBe("Pho");
  });
});

describe("reimport — imported/skipped counts (Req 9.3, 9.5)", () => {
  it("reports one import per valid row and one skip per malformed row", async () => {
    const validMeal = rowFromEvent(meal("v1", "Curry"), labelFor);
    const validCheckin = rowFromEvent(
      { id: "v2", createdAt: 1_700_000_100_000, type: "checkin", stress: "low" },
      labelFor,
    );

    // Malformed: a row with an empty id, and a row with an unknown event type.
    const noId = [...validMeal];
    noId[10] = "";
    const unknownType = [...validMeal];
    unknownType[1] = "bogus";
    unknownType[10] = "v3";

    router = readRouter([validMeal, noId, validCheckin, unknownType]);

    await expect(reimport()).resolves.toEqual({ imported: 2, skipped: 2 });

    // Only the valid rows were merged locally.
    expect([...h.store.keys()].sort()).toEqual(["v1", "v2"]);
  });

  it("does not record a sync completion timestamp (a re-import is not a sync)", async () => {
    router = readRouter([rowFromEvent(meal("v1", "Curry"), labelFor)]);

    await reimport();

    expect(getLastSyncAt()).toBeNull();
  });
});

describe("reimport — a failed read leaves local data unchanged (Req 9.6)", () => {
  it("sets the error status and writes nothing locally when the sheet read fails", async () => {
    h.store.set("a", meal("a", "Toast"));
    h.store.set("b", meal("b", "Soup"));
    const before = [...h.store.entries()].map(([id, e]) => [id, { ...e }] as const);

    router = readFailsRouter;

    await expect(reimport()).rejects.toThrow();

    // Every local event is byte-for-byte what it was before the attempt.
    expect(h.store.size).toBe(2);
    expect([...h.store.entries()].map(([id, e]) => [id, { ...e }] as const)).toEqual(before);

    // Error indication surfaced to the UI (Req 9.6).
    expect(getStatus().state).toBe("error");
  });
});

describe("reimport — disconnected does not initiate a re-import (Req 9.7)", () => {
  it("returns zero counts without any request or local write", async () => {
    clearSpreadsheetId();
    expect(isSheetsConnected()).toBe(false);

    h.store.set("a", meal("a", "Toast"));

    await expect(reimport()).resolves.toEqual({ imported: 0, skipped: 0 });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(h.store.size).toBe(1);
    expect((h.store.get("a") as MealEvent).dish).toBe("Toast");
  });
});
