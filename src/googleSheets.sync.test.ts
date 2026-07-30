import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// A spreadsheet row carries no Revision_Time, so these fixtures and the row
// mapping work over `DraftEvent` — a log event without the `updatedAt` that
// `putEvent` assigns on the way into the Local_Store.
import type { DraftEvent } from "./db";

// Task 12.3 — Integration tests for sync outcomes (mocked GIS + `fetch` + `db`).
//
// These exercise `syncAll` end-to-end across the I/O shell, asserting the
// outcome-level guarantees:
//   - a successful sync records the completion timestamp and derives "synced"
//     (Req 4.6, 6.1)
//   - a failure sets the error status and leaves the previous completion
//     timestamp unchanged (Req 10.5), and a later retry succeeds, records a new
//     timestamp, and clears the error status (Req 5.6, 10.3)
//   - with no connectivity no Google API request is made at all (Req 10.2)
//   - local logging keeps working while the error status is set, and the error
//     status persists until a successful sync (Req 10.4, 6.3)
//   - a disconnected trigger is a no-op (Req 5.4)
//
// Validates: Requirements 4.6, 5.6, 10.2, 10.3, 10.4

// ---- Fake local event store (stands in for IndexedDB) ----
//
// `googleSheets.ts` reads local events through `getEvents` and writes through
// `putEvent`; both are redirected to an in-memory map so the tests control the
// sync input and can observe that local logging still succeeds during an error.

const h = vi.hoisted(() => ({ store: new Map<string, DraftEvent>() }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getEvents: async () => [...h.store.values()],
    putEvent: async (e: DraftEvent) => {
      h.store.set(e.id, e);
    },
  };
});

import { putEvent } from "./db";
import {
  syncAll,
  getStatus,
  getLastSyncAt,
  setLastSyncAt,
  setSpreadsheetId,
  clearSpreadsheetId,
  setRuntime,
  resetGisForTests,
  isSheetsConnected,
  SHEET_HEADER,
} from "./googleSheets";
import {
  applyEntitlement,
  clearPersistedSyncSettingsForTests,
  resetSyncSettingsForTests,
  restore,
  setDestinationEnabled,
} from "./syncSettings";

const SPREADSHEET_ID_KEY = "food-snap-sheets-spreadsheet-id";
const LAST_SYNC_KEY = "food-snap-sheets-last-sync";

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

/** Router serving a sheet that contains only the header row (all appends). */
const successRouter = (url: string, init: RequestInit): Response => {
  if (url.includes(":append") && method(init) === "POST") {
    return jsonResponse({ updates: { updatedRows: 1 } });
  }
  if (url.includes("values:batchUpdate") && method(init) === "POST") {
    return jsonResponse({ totalUpdatedRows: 1 });
  }
  if (url.includes("/values/") && method(init) === "GET") {
    return jsonResponse({ values: [[...SHEET_HEADER]] });
  }
  throw new Error(`Unexpected fetch to ${url}`);
};

/** Router whose read of the sheet fails with a 500. */
const readFailsRouter = (url: string, init: RequestInit): Response => {
  if (url.includes("/values/") && method(init) === "GET") {
    return jsonResponse({}, { ok: false, status: 500, statusText: "Internal Server Error" });
  }
  throw new Error(`Unexpected fetch to ${url}`);
};

/** Requests recorded so far that hit an append endpoint. */
function appendCalls(): Recorded[] {
  return calls.filter((c) => c.url.includes(":append") && method(c.init) === "POST");
}

function meal(id: string, createdAt: number): DraftEvent {
  return {
    id,
    createdAt,
    type: "meal",
    dish: `dish ${id}`,
    ingredients: [{ name: "rice", confidence: "confident" }],
  };
}

beforeEach(async () => {
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");

  // Fresh persistence + runtime + local store for every case.
  localStorage.removeItem(SPREADSHEET_ID_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
  h.store.clear();
  resetGisForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  await restore();
  setRuntime({ phase: "idle" });

  // Active: all four conditions of cloud-sync Req 15.2 — the Client ID above, the
  // shared enabled flag, Pro_Entitlement, and a stored spreadsheet id.
  applyEntitlement({ pro: true, proUntil: null });
  setDestinationEnabled("sheets", true);
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
  router = successRouter;
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
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  h.store.clear();
  setRuntime({ phase: "idle" });
});

describe("syncAll — success records the completion timestamp (Req 4.6)", () => {
  it("writes the event rows and records a fresh last-sync timestamp", async () => {
    h.store.set("e1", meal("e1", 1_700_000_000_000));
    h.store.set("e2", meal("e2", 1_700_000_100_000));

    const before = Date.now();
    await syncAll();
    const after = Date.now();

    // Completion timestamp recorded (Req 4.6) and close to "now".
    const last = getLastSyncAt();
    expect(typeof last).toBe("number");
    expect(last).not.toBeNull();
    expect(last as number).toBeGreaterThanOrEqual(before);
    expect(last as number).toBeLessThanOrEqual(after);

    // Status derives "synced" with that timestamp (Req 6.1).
    expect(getStatus()).toEqual({ state: "synced", lastSyncAt: last });

    // Both events were appended (header-only sheet → all appends).
    const appends = appendCalls();
    expect(appends).toHaveLength(1);
    const body = JSON.parse(appends[0].init.body as string) as { values: string[][] };
    const ids = body.values.map((row) => row[row.length - 1]);
    expect(ids).toEqual(["e1", "e2"]);
  });
});

describe("syncAll — failure then retry (Req 5.6, 10.3, 10.5)", () => {
  it("preserves the prior timestamp on failure, then a retry clears the error and records a new one", async () => {
    const PRIOR = 12345;
    setLastSyncAt(PRIOR);
    h.store.set("e1", meal("e1", 1_700_000_000_000));

    // --- Failure: the sheet read returns 500 ---
    router = readFailsRouter;
    await expect(syncAll()).rejects.toThrow();

    const failed = getStatus();
    expect(failed.state).toBe("error");
    // The failed sync kept the last successful completion timestamp (Req 10.5).
    expect(failed.state === "error" ? failed.lastSyncAt : null).toBe(PRIOR);
    expect(getLastSyncAt()).toBe(PRIOR);

    // --- Retry succeeds ---
    router = successRouter;
    await syncAll();

    const status = getStatus();
    expect(status.state).toBe("synced"); // error cleared (Req 10.3)
    expect(getLastSyncAt()).toBeGreaterThan(PRIOR); // new timestamp (Req 10.3)
    expect(status.state === "synced" ? status.lastSyncAt : null).toBe(getLastSyncAt());
  });
});

describe("syncAll — offline makes no request (Req 10.2)", () => {
  it("rejects with an offline message without touching the network", async () => {
    h.store.set("e1", meal("e1", 1_700_000_000_000));

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

    await expect(syncAll()).rejects.toThrow(/offline/i);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(getStatus().state).toBe("error");
    expect(getLastSyncAt()).toBeNull(); // no completion timestamp recorded
  });
});

describe("logging while the error status is set (Req 10.4, 6.3)", () => {
  it("stores a new local event and keeps the error status until a successful sync", async () => {
    router = readFailsRouter;
    await expect(syncAll()).rejects.toThrow();
    expect(getStatus().state).toBe("error");

    // The app keeps accepting and storing new events locally (Req 10.4).
    await putEvent({ id: "new-1", createdAt: Date.now(), type: "checkin" });
    expect(h.store.has("new-1")).toBe(true);

    // The error status persists until a subsequent sync succeeds (Req 6.3, 10.3).
    expect(getStatus().state).toBe("error");
  });
});

describe("syncAll — an inactive destination is a no-op (Req 5.4, cloud-sync Req 15.2, 15.4)", () => {
  it("resolves without a request when no spreadsheet is connected", async () => {
    // Entitlement and the shared enabled flag are on (set up above); only the
    // stored spreadsheet id is missing, so the gate closes.
    clearSpreadsheetId();
    expect(isSheetsConnected()).toBe(false);

    await expect(syncAll()).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolves without a request after a Pro_Lapse, leaving the spreadsheet id intact", async () => {
    h.store.set("e1", meal("e1", 1_700_000_000_000));

    // Pro lapses: the entitlement snapshot is applied synchronously, so the very
    // next trigger is already gated (cloud-sync Req 15.4).
    applyEntitlement({ pro: false, proUntil: null });
    expect(isSheetsConnected()).toBe(false);

    await expect(syncAll()).resolves.toBeUndefined();

    // Zero requests to Google, and nothing local or persisted was disturbed.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(localStorage.getItem(SPREADSHEET_ID_KEY)).toBe("sheet-1");
    expect(getLastSyncAt()).toBeNull();
    expect(h.store.get("e1")).toEqual(meal("e1", 1_700_000_000_000));
  });

  it("resolves without a request while the shared enabled flag is off (cloud-sync Req 15.5)", async () => {
    setDestinationEnabled("sheets", false);
    expect(isSheetsConnected()).toBe(false);

    await expect(syncAll()).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
