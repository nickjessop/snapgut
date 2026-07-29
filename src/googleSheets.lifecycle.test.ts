import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSpreadsheet,
  writeHeader,
  driveFileExists,
  ensureSpreadsheet,
  setSpreadsheetId,
  getSpreadsheetId,
  SPREADSHEET_TITLE,
  SHEET_TITLE,
  SHEET_HEADER,
} from "./googleSheets";

// Task 10.2 — Integration tests for the spreadsheet lifecycle (mocked `fetch`).
//
// These exercise the I/O-shell REST boundary of the lifecycle helpers by mocking
// the global `fetch`. They assert:
//   - createSpreadsheet posts the exact "Food Snap Data" title + "Log" sheet and
//     returns the new spreadsheetId (Req 2.2)
//   - writeHeader writes SHEET_HEADER to Log!A1 with RAW input (Req 2.3)
//   - ensureSpreadsheet reuses a stored id whose Drive file exists (Req 7.6)
//   - ensureSpreadsheet recreates when the stored file is missing (404) or
//     trashed (Req 7.7)
//   - driveFileExists maps 200/404/trashed/other-status correctly
//
// Validates: Requirements 2.2, 2.3, 7.6, 7.7

const SPREADSHEET_ID_KEY = "food-snap-sheets-spreadsheet-id";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_FILES_API_BASE = "https://www.googleapis.com/drive/v3/files";

const TOKEN = "test-access-token";

// ---- fetch mock plumbing ----
//
// A single mock records every call as { url, init } and routes the response via
// a swappable `router` so a single mockFetch can serve multi-step flows (create
// then header write).

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

beforeEach(() => {
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
  localStorage.removeItem(SPREADSHEET_ID_KEY);

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
  localStorage.removeItem(SPREADSHEET_ID_KEY);
});

describe("createSpreadsheet (Req 2.2)", () => {
  it("POSTs the correct title/sheet with a bearer token and returns the new id", async () => {
    router = (url, init) => {
      if (url === SHEETS_API_BASE && method(init) === "POST") {
        return jsonResponse({ spreadsheetId: "new-id" });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const id = await createSpreadsheet(TOKEN);

    expect(id).toBe("new-id");
    expect(calls).toHaveLength(1);

    const { url, init } = calls[0];
    expect(url).toBe(SHEETS_API_BASE);
    expect(method(init)).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);

    const body = JSON.parse(init.body as string);
    expect(body.properties.title).toBe(SPREADSHEET_TITLE);
    expect(body.properties.title).toBe("Food Snap Data");
    expect(body.sheets[0].properties.title).toBe(SHEET_TITLE);
    expect(body.sheets[0].properties.title).toBe("Log");
  });

  it("throws when the create response omits a spreadsheetId", async () => {
    router = () => jsonResponse({});
    await expect(createSpreadsheet(TOKEN)).rejects.toThrow(/spreadsheetId/);
  });
});

describe("writeHeader (Req 2.3)", () => {
  it("PUTs SHEET_HEADER to the Log!A1 range with RAW input", async () => {
    router = (url, init) => {
      if (url.includes("/values/") && method(init) === "PUT") {
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    await writeHeader(TOKEN, "sheet-1");

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];

    // Range Log!A1 is URL-encoded; valueInputOption=RAW is present.
    expect(url).toContain(`${SHEETS_API_BASE}/sheet-1/values/`);
    expect(url).toContain(encodeURIComponent("Log!A1"));
    expect(url).toContain("valueInputOption=RAW");
    expect(method(init)).toBe("PUT");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);

    const body = JSON.parse(init.body as string);
    expect(body.values).toEqual([[...SHEET_HEADER]]);
  });
});

describe("driveFileExists (Req 7.6, 7.7)", () => {
  it("returns true for a 200 response with trashed:false", async () => {
    router = () => jsonResponse({ id: "sheet-1", trashed: false });
    await expect(driveFileExists(TOKEN, "sheet-1")).resolves.toBe(true);

    const { url, init } = calls[0];
    expect(url).toContain(DRIVE_FILES_API_BASE);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns false for a 404 (file gone)", async () => {
    router = () => jsonResponse({}, { ok: false, status: 404, statusText: "Not Found" });
    await expect(driveFileExists(TOKEN, "gone-id")).resolves.toBe(false);
  });

  it("returns false when the file is trashed", async () => {
    router = () => jsonResponse({ id: "t", trashed: true });
    await expect(driveFileExists(TOKEN, "t")).resolves.toBe(false);
  });

  it("throws on other non-2xx responses (transient error, not a missing file)", async () => {
    router = () =>
      jsonResponse({}, { ok: false, status: 500, statusText: "Internal Server Error" });
    await expect(driveFileExists(TOKEN, "sheet-1")).rejects.toThrow(/500/);
  });
});

describe("ensureSpreadsheet — reuse vs recreate (Req 7.6, 7.7)", () => {
  it("reuses a stored id when its Drive file exists, without creating (Req 7.6)", async () => {
    setSpreadsheetId("existing-id");

    router = (url, init) => {
      if (url.includes("/drive/v3/files") && method(init) === "GET") {
        return jsonResponse({ id: "existing-id", trashed: false });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const id = await ensureSpreadsheet(TOKEN);

    expect(id).toBe("existing-id");
    // Only the Drive existence check happened — no spreadsheet was created.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/drive/v3/files");
    const createCalls = calls.filter(
      (c) => c.url === SHEETS_API_BASE && method(c.init) === "POST",
    );
    expect(createCalls).toHaveLength(0);
    expect(getSpreadsheetId()).toBe("existing-id");
  });

  it("recreates when the stored file is missing (404): creates, writes header, stores id (Req 7.7)", async () => {
    setSpreadsheetId("gone-id");

    router = (url, init) => {
      if (url.includes("/drive/v3/files") && method(init) === "GET") {
        return jsonResponse({}, { ok: false, status: 404, statusText: "Not Found" });
      }
      if (url === SHEETS_API_BASE && method(init) === "POST") {
        return jsonResponse({ spreadsheetId: "fresh-id" });
      }
      if (url.includes("/values/") && method(init) === "PUT") {
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const id = await ensureSpreadsheet(TOKEN);

    expect(id).toBe("fresh-id");
    // A new spreadsheet was created and its header written.
    const createCalls = calls.filter(
      (c) => c.url === SHEETS_API_BASE && method(c.init) === "POST",
    );
    expect(createCalls).toHaveLength(1);
    const headerCalls = calls.filter(
      (c) => c.url.includes("/values/") && method(c.init) === "PUT",
    );
    expect(headerCalls).toHaveLength(1);
    const headerBody = JSON.parse(headerCalls[0].init.body as string);
    expect(headerBody.values).toEqual([[...SHEET_HEADER]]);
    // The new id was persisted (setSpreadsheetId).
    expect(getSpreadsheetId()).toBe("fresh-id");
  });

  it("recreates when the stored file is trashed (Req 7.7)", async () => {
    setSpreadsheetId("trashed-id");

    router = (url, init) => {
      if (url.includes("/drive/v3/files") && method(init) === "GET") {
        return jsonResponse({ id: "trashed-id", trashed: true });
      }
      if (url === SHEETS_API_BASE && method(init) === "POST") {
        return jsonResponse({ spreadsheetId: "fresh-id" });
      }
      if (url.includes("/values/") && method(init) === "PUT") {
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const id = await ensureSpreadsheet(TOKEN);

    expect(id).toBe("fresh-id");
    expect(getSpreadsheetId()).toBe("fresh-id");
  });

  it("creates a fresh spreadsheet when no id is stored (initial connect)", async () => {
    // No stored id — should skip the Drive check and create directly.
    router = (url, init) => {
      if (url === SHEETS_API_BASE && method(init) === "POST") {
        return jsonResponse({ spreadsheetId: "brand-new" });
      }
      if (url.includes("/values/") && method(init) === "PUT") {
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const id = await ensureSpreadsheet(TOKEN);

    expect(id).toBe("brand-new");
    // No Drive existence check when there is no stored id.
    const driveCalls = calls.filter((c) => c.url.includes("/drive/v3/files"));
    expect(driveCalls).toHaveLength(0);
    expect(getSpreadsheetId()).toBe("brand-new");
  });
});
