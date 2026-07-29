import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  connect,
  disconnect,
  getStatus,
  getSpreadsheetId,
  setSpreadsheetId,
  isSheetsConnected,
  resetGisForTests,
} from "./googleSheets";

// Task 11.2 — Integration tests for the connect/disconnect lifecycle
// (mocked GIS + mocked `fetch`).
//
// These exercise the full connect/disconnect flows end to end through the I/O
// shell. They assert:
//   - the Spreadsheet_Id is persisted ONLY after the header write succeeds, so a
//     failed header write leaves the integration disconnected (Req 2.4, 2.7)
//   - a successful connect stores the id and reports connected (Req 2.4)
//   - reconnecting with an existing, still-present spreadsheet reuses its id and
//     never creates a second spreadsheet (Req 2.6 / 7.6)
//   - a denied consent stores nothing and issues no API calls (Req 2.5)
//   - disconnect revokes the token, clears local state, and never touches the
//     remote spreadsheet (no DELETE is ever issued) (Req 7.1, 7.2, 7.3)
//   - a failed remote revoke still completes the local disconnect (Req 7.5)
//
// Validates: Requirements 2.4, 2.6, 7.1, 7.3, 7.5

const SPREADSHEET_ID_KEY = "food-snap-sheets-spreadsheet-id";
const LAST_SYNC_KEY = "food-snap-sheets-last-sync";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

// ---- Mock GIS surface (same pattern as googleSheets.gis.test.ts) ----

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type Client = {
  callback: (r: TokenResponse) => void;
  requestAccessToken: ReturnType<typeof vi.fn>;
};

let client: Client;
let mockOauth2: {
  initTokenClient: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
};

/** How the current test wants requestAccessToken to respond. */
let responder: (c: Client) => void;

/** Responder that grants a token with the given lifetime. */
function grants(accessToken: string, expiresIn = 3600): (c: Client) => void {
  return (c) => c.callback({ access_token: accessToken, expires_in: expiresIn });
}

/** Responder that denies the request (user cancelled / denied consent). */
function denies(error = "access_denied"): (c: Client) => void {
  return (c) => c.callback({ error });
}

// ---- Mock fetch (same pattern as googleSheets.lifecycle.test.ts) ----

type Recorded = { url: string; init: RequestInit };

let calls: Recorded[];
let router: (url: string, init: RequestInit) => Response;
let mockFetch: ReturnType<typeof vi.fn>;

/** Build a minimal Response-like object with the given status + JSON body. */
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

/** The `init` method (defaulting to GET) for a recorded/routed request. */
function method(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase();
}

/** Recorded POSTs to the spreadsheets collection (spreadsheet creation). */
function createCalls(): Recorded[] {
  return calls.filter((c) => c.url === SHEETS_API_BASE && method(c.init) === "POST");
}

/** Router serving a successful create + header write (fresh connect). */
function freshConnectRouter(id: string): (url: string, init: RequestInit) => Response {
  return (url, init) => {
    if (url === SHEETS_API_BASE && method(init) === "POST") {
      return jsonResponse({ spreadsheetId: id });
    }
    if (url.includes("/values/") && method(init) === "PUT") {
      return jsonResponse({});
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };
}

function clearStorage(): void {
  localStorage.removeItem(SPREADSHEET_ID_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
}

beforeEach(() => {
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
  resetGisForTests();
  clearStorage();

  responder = grants("token-abc");

  client = {
    callback: () => {},
    requestAccessToken: vi.fn(() => responder(client)),
  };

  mockOauth2 = {
    initTokenClient: vi.fn(() => client),
    revoke: vi.fn((_token: string, done?: () => void) => done && done()),
  };

  (globalThis as unknown as { google: unknown }).google = {
    accounts: { oauth2: mockOauth2 },
  };

  calls = [];
  // Default router: unmatched requests fail loudly so tests must opt in.
  router = (url) => {
    throw new Error(`Unexpected fetch to ${url}`);
  };

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
  resetGisForTests();
  delete (globalThis as unknown as { google?: unknown }).google;
  clearStorage();
});

describe("connect — Spreadsheet_Id persistence ordering (Req 2.4, 2.7)", () => {
  it("does not store the id when the header write fails, staying disconnected", async () => {
    expect(getSpreadsheetId()).toBeNull();

    router = (url, init) => {
      if (url === SHEETS_API_BASE && method(init) === "POST") {
        return jsonResponse({ spreadsheetId: "new-id" });
      }
      if (url.includes("/values/") && method(init) === "PUT") {
        // Header write fails → the id must never be persisted (Req 2.4).
        return jsonResponse({}, { ok: false, status: 500, statusText: "Server Error" });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    await expect(connect()).rejects.toThrow();

    // The spreadsheet was created remotely, but no id entered Connected_State.
    expect(createCalls()).toHaveLength(1);
    expect(getSpreadsheetId()).toBeNull();
    expect(isSheetsConnected()).toBe(false);
    expect(getStatus()).toEqual({ state: "disconnected" });
  });

  it("stores the id after a successful header write and reports connected", async () => {
    router = freshConnectRouter("new-id");

    await expect(connect()).resolves.toBeUndefined();

    expect(getSpreadsheetId()).toBe("new-id");
    expect(isSheetsConnected()).toBe(true);
    expect(getStatus()).toEqual({ state: "connected", lastSyncAt: null });
  });
});

describe("connect — reconnect reuses the existing spreadsheet (Req 2.6)", () => {
  it("reuses the stored id when its Drive file still exists, without creating another", async () => {
    setSpreadsheetId("existing-id");

    router = (url, init) => {
      if (url.includes("/drive/v3/files") && method(init) === "GET") {
        return jsonResponse({ id: "existing-id", trashed: false });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    await expect(connect()).resolves.toBeUndefined();

    expect(getSpreadsheetId()).toBe("existing-id");
    expect(createCalls()).toHaveLength(0);
    expect(getStatus()).toEqual({ state: "connected", lastSyncAt: null });
  });
});

describe("connect — denied consent (Req 2.5)", () => {
  it("stays disconnected and issues no API calls when the user denies consent", async () => {
    responder = denies("access_denied");

    await expect(connect()).rejects.toThrow();

    expect(getSpreadsheetId()).toBeNull();
    expect(isSheetsConnected()).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("disconnect (Req 7.1, 7.2, 7.3)", () => {
  it("revokes the token, clears local state, and never deletes the remote spreadsheet", async () => {
    router = freshConnectRouter("new-id");
    await connect();
    expect(isSheetsConnected()).toBe(true);

    await expect(disconnect()).resolves.toBeUndefined();

    // Token revoked remotely (Req 7.1).
    expect(mockOauth2.revoke).toHaveBeenCalledTimes(1);
    expect(mockOauth2.revoke.mock.calls[0][0]).toBe("token-abc");

    // Local connection state cleared (Req 7.2).
    expect(getSpreadsheetId()).toBeNull();
    expect(isSheetsConnected()).toBe(false);
    expect(getStatus()).toEqual({ state: "disconnected" });

    // Remote spreadsheet untouched: no DELETE, no Drive files delete (Req 7.3).
    expect(calls.filter((c) => method(c.init) === "DELETE")).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/drive/v3/files"))).toHaveLength(0);
  });

  it("still disconnects locally when the remote revoke fails (Req 7.5)", async () => {
    router = freshConnectRouter("new-id");
    await connect();
    expect(isSheetsConnected()).toBe(true);

    mockOauth2.revoke = vi.fn(() => {
      throw new Error("revoke failed");
    });
    (globalThis as unknown as { google: unknown }).google = {
      accounts: { oauth2: mockOauth2 },
    };

    await expect(disconnect()).rejects.toThrow(/couldn't be revoked remotely/i);

    // Local disconnect completed despite the revoke failure.
    expect(getSpreadsheetId()).toBeNull();
    expect(isSheetsConnected()).toBe(false);
    expect(calls.filter((c) => method(c.init) === "DELETE")).toHaveLength(0);
  });
});
