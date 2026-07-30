import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getStatus,
  subscribe,
  isSheetsConnected,
  getSpreadsheetId,
  setSpreadsheetId,
  clearSpreadsheetId,
  getLastSyncAt,
  setLastSyncAt,
  setRuntime,
  type SyncStatus,
} from "./googleSheets";
import {
  applyEntitlement,
  clearPersistedSyncSettingsForTests,
  resetSyncSettingsForTests,
  restore,
  setDestinationEnabled,
} from "./syncSettings";

// Task 8.2 — Unit tests for status derivation and persistence.
//
// Covers each SyncStatus branch (disabled / disconnected / connected / syncing /
// synced / error), last-sync read/write persistence, spreadsheet-id persistence
// driving isSheetsConnected(), and the subscribe/notify pub/sub.
//
// Validates: Requirements 6.1, 6.2, 6.3, 6.4
//
// Task 4.2 (cloud-sync) — `isSheetsConnected()` now also requires Pro_Entitlement
// and the shared enabled flag owned by `syncSettings` (cloud-sync Req 15.2, 15.5),
// so the stored-id cases below carry Pro-on / Pro-off / enabled-off variants.
// `getStatus()` is deliberately untouched by that gate: it reports the connection
// the user set up, and the paused-during-lapse status line is task 15.2's job.
//
// Validates: Requirements 15.1, 15.2 (cloud-sync)
//
// isSheetsEnabled() reads import.meta.env.VITE_GOOGLE_CLIENT_ID at call time, so
// vi.stubEnv is the standard way to simulate enabled/disabled here.

// localStorage keys mirrored from googleSheets.ts (design "Local persistence").
const SPREADSHEET_ID_KEY = "food-snap-sheets-spreadsheet-id";
const LAST_SYNC_KEY = "food-snap-sheets-last-sync";

/** Simulate the integration being configured (Client ID present). */
function enableSheets(): void {
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
}

/** Simulate the integration being unconfigured (Client ID absent). */
function disableSheets(): void {
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
}

/** Pro_Entitlement true, with no expiry (cloud-sync Req 15.2 condition 3). */
function grantPro(): void {
  applyEntitlement({ pro: true, proUntil: null });
}

/** A Pro_Lapse: the entitlement snapshot says not Pro (cloud-sync Req 15.4). */
function lapsePro(): void {
  applyEntitlement({ pro: false, proUntil: null });
}

/** The shared enabled flag for the Sheets destination (cloud-sync Req 15.5). */
function enableDestination(): void {
  setDestinationEnabled("sheets", true);
}

beforeEach(async () => {
  // Reset durable + runtime state between tests so the module singleton is clean.
  localStorage.removeItem(SPREADSHEET_ID_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  await restore();
  setRuntime({ phase: "idle" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  localStorage.removeItem(SPREADSHEET_ID_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  setRuntime({ phase: "idle" });
});

describe("getStatus — SyncStatus branch derivation", () => {
  it("returns 'disabled' when the Client ID is not configured (Req 1.3)", () => {
    disableSheets();
    // Even with a stored spreadsheet id, an unconfigured integration is disabled.
    setSpreadsheetId("sheet-1");
    expect(getStatus()).toEqual<SyncStatus>({ state: "disabled" });
  });

  it("returns 'disconnected' when enabled but no spreadsheet id is stored", () => {
    enableSheets();
    expect(getSpreadsheetId()).toBeNull();
    expect(getStatus()).toEqual<SyncStatus>({ state: "disconnected" });
  });

  it("returns 'connected' with lastSyncAt null when connected, idle, and never synced (Req 6.4)", () => {
    enableSheets();
    setSpreadsheetId("sheet-1");
    // No last-sync recorded, runtime idle.
    expect(getStatus()).toEqual<SyncStatus>({ state: "connected", lastSyncAt: null });
  });

  it("returns 'syncing' while a sync is in progress (Req 6.2)", () => {
    enableSheets();
    setSpreadsheetId("sheet-1");
    setRuntime({ phase: "syncing" });
    expect(getStatus()).toEqual<SyncStatus>({ state: "syncing", lastSyncAt: null });
  });

  it("returns 'syncing' with the last-sync timestamp when a prior sync had completed", () => {
    enableSheets();
    setSpreadsheetId("sheet-1");
    setLastSyncAt(999);
    setRuntime({ phase: "syncing" });
    expect(getStatus()).toEqual<SyncStatus>({ state: "syncing", lastSyncAt: 999 });
  });

  it("returns 'synced' with the recorded timestamp when connected, idle, and synced (Req 6.1)", () => {
    enableSheets();
    setSpreadsheetId("sheet-1");
    setLastSyncAt(12345);
    expect(getStatus()).toEqual<SyncStatus>({ state: "synced", lastSyncAt: 12345 });
  });

  it("returns 'error' with the message when the most recent sync failed (Req 6.3)", () => {
    enableSheets();
    setSpreadsheetId("sheet-1");
    setRuntime({ phase: "error", message: "boom" });
    expect(getStatus()).toEqual<SyncStatus>({
      state: "error",
      lastSyncAt: null,
      message: "boom",
    });
  });

  it("returns 'error' preserving the last-sync timestamp on failure (Req 10.5)", () => {
    enableSheets();
    setSpreadsheetId("sheet-1");
    setLastSyncAt(555);
    setRuntime({ phase: "error", message: "network down" });
    expect(getStatus()).toEqual<SyncStatus>({
      state: "error",
      lastSyncAt: 555,
      message: "network down",
    });
  });

  it("falls back to a default error message when none is provided", () => {
    enableSheets();
    setSpreadsheetId("sheet-1");
    setRuntime({ phase: "error" });
    expect(getStatus()).toEqual<SyncStatus>({
      state: "error",
      lastSyncAt: null,
      message: "Sync failed",
    });
  });
});

describe("persistence — spreadsheet id and connection state", () => {
  it("setSpreadsheetId makes isSheetsConnected() true when enabled, entitled, and switched on", () => {
    enableSheets();
    grantPro();
    enableDestination();
    expect(isSheetsConnected()).toBe(false);
    setSpreadsheetId("sheet-1");
    expect(getSpreadsheetId()).toBe("sheet-1");
    expect(isSheetsConnected()).toBe(true);
  });

  it("clearSpreadsheetId makes isSheetsConnected() false again", () => {
    enableSheets();
    grantPro();
    enableDestination();
    setSpreadsheetId("sheet-1");
    expect(isSheetsConnected()).toBe(true);
    clearSpreadsheetId();
    expect(getSpreadsheetId()).toBeNull();
    expect(isSheetsConnected()).toBe(false);
  });

  it("isSheetsConnected() stays false when disabled even with a stored id (Req 1.3)", () => {
    disableSheets();
    grantPro();
    enableDestination();
    setSpreadsheetId("sheet-1");
    // The id is stored and Pro is held, but the config gate overrides all of it.
    expect(getSpreadsheetId()).toBe("sheet-1");
    expect(isSheetsConnected()).toBe(false);
  });

  // ---- cloud-sync Req 15.2: all four conditions are necessary ----

  it("isSheetsConnected() is false with a stored id while Pro is off (cloud-sync Req 15.2)", () => {
    enableSheets();
    enableDestination();
    setSpreadsheetId("sheet-1");
    lapsePro();

    // Config on, destination on, id stored — only entitlement is missing, and the
    // gate closes anyway.
    expect(getSpreadsheetId()).toBe("sheet-1");
    expect(isSheetsConnected()).toBe(false);
  });

  it("isSheetsConnected() is false with a stored id before any entitlement is known (cloud-sync Req 1.9)", () => {
    enableSheets();
    enableDestination();
    setSpreadsheetId("sheet-1");

    // Cold start: no entitlement snapshot has ever been persisted, so the gate
    // fails closed.
    expect(isSheetsConnected()).toBe(false);
  });

  it("isSheetsConnected() is false with a stored id while the shared enabled flag is off (cloud-sync Req 15.5)", () => {
    enableSheets();
    grantPro();
    setSpreadsheetId("sheet-1");

    // The enabled state is owned by `syncSettings`, not by the stored id.
    expect(getSpreadsheetId()).toBe("sheet-1");
    expect(isSheetsConnected()).toBe(false);
  });

  it("a Pro_Lapse closes the gate without disturbing the stored id, and Pro's return reopens it (cloud-sync Req 15.4, 15.9)", () => {
    enableSheets();
    grantPro();
    enableDestination();
    setSpreadsheetId("sheet-1");
    expect(isSheetsConnected()).toBe(true);

    lapsePro();
    expect(isSheetsConnected()).toBe(false);
    // The spreadsheet id survives the lapse, so resumption reuses it (Req 15.9).
    expect(getSpreadsheetId()).toBe("sheet-1");

    grantPro();
    expect(isSheetsConnected()).toBe(true);
    expect(getSpreadsheetId()).toBe("sheet-1");
  });

  it("treats an expired proUntil as not entitled", () => {
    enableSheets();
    enableDestination();
    setSpreadsheetId("sheet-1");
    applyEntitlement({ pro: true, proUntil: Date.now() - 1 });

    expect(isSheetsConnected()).toBe(false);
  });
});

describe("persistence — last-sync read/write", () => {
  it("returns null when the last-sync timestamp is unset", () => {
    expect(getLastSyncAt()).toBeNull();
  });

  it("round-trips a written last-sync timestamp", () => {
    setLastSyncAt(1720000000000);
    expect(getLastSyncAt()).toBe(1720000000000);
  });

  it("round-trips a zero timestamp as a finite number", () => {
    setLastSyncAt(0);
    expect(getLastSyncAt()).toBe(0);
  });

  it("returns null for a non-numeric stored value", () => {
    // Simulate a corrupted/non-numeric stored value.
    localStorage.setItem(LAST_SYNC_KEY, "not-a-number");
    expect(getLastSyncAt()).toBeNull();
  });
});

describe("subscribe / notify", () => {
  it("invokes the listener with the derived status when connection state changes", () => {
    enableSheets();
    const calls: SyncStatus[] = [];
    const unsubscribe = subscribe((s) => calls.push(s));

    setSpreadsheetId("sheet-1");

    // The most recent notification should reflect the connected status.
    expect(calls[calls.length - 1]).toEqual<SyncStatus>({ state: "connected", lastSyncAt: null });
    unsubscribe();
  });

  it("invokes the listener when the runtime phase changes", () => {
    enableSheets();
    setSpreadsheetId("sheet-1");

    const calls: SyncStatus[] = [];
    const unsubscribe = subscribe((s) => calls.push(s));

    setRuntime({ phase: "syncing" });
    expect(calls[calls.length - 1]).toEqual<SyncStatus>({ state: "syncing", lastSyncAt: null });

    setRuntime({ phase: "error", message: "boom" });
    expect(calls[calls.length - 1]).toEqual<SyncStatus>({
      state: "error",
      lastSyncAt: null,
      message: "boom",
    });

    unsubscribe();
  });

  it("invokes the listener when a last-sync timestamp is recorded", () => {
    enableSheets();
    setSpreadsheetId("sheet-1");

    const calls: SyncStatus[] = [];
    const unsubscribe = subscribe((s) => calls.push(s));

    setLastSyncAt(42);
    expect(calls[calls.length - 1]).toEqual<SyncStatus>({ state: "synced", lastSyncAt: 42 });
    unsubscribe();
  });

  it("stops notifying after the listener unsubscribes", () => {
    enableSheets();
    setSpreadsheetId("sheet-1");

    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    unsubscribe();

    const callsAfterUnsub = listener.mock.calls.length;
    setRuntime({ phase: "syncing" });
    setLastSyncAt(1);
    clearSpreadsheetId();

    expect(listener).toHaveBeenCalledTimes(callsAfterUnsub);
  });
});
