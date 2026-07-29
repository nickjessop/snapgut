import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
// A spreadsheet row carries no Revision_Time, so these fixtures and the row
// mapping work over `DraftEvent` — a log event without the `updatedAt` that
// `putEvent` assigns on the way into the Local_Store.
import type { DraftEvent } from "./db";

// Task 15.4 — UI wiring tests for the Google Sheets integration.
//
// These are example (unit) tests over the two wired-up views, asserting the
// gating that the requirements demand at the UI level:
//   - no Client ID configured → no Google Sheets controls anywhere (Req 1.1)
//   - Client ID configured → controls appear, shaped by connection state (Req 1.2)
//   - an active Sheets connection replaces the manual backup nudge (Req 8.1)
//   - connecting while the nudge is on screen dismisses it right away (Req 8.2)
//
// Validates: Requirements 1.1, 1.2, 8.1, 8.2

// ---- Fake local event store (stands in for IndexedDB) ----
//
// `LogsView` loads the timeline through `getEvents`; jsdom has no IndexedDB, so
// the store is redirected to an in-memory list the tests seed directly.

const h = vi.hoisted(() => ({ store: [] as DraftEvent[] }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getEvents: async () => [...h.store],
    putEvent: async (e: DraftEvent) => {
      h.store.push(e);
    },
    deleteEvent: async (id: string) => {
      h.store = h.store.filter((e) => e.id !== id);
    },
  };
});

// `SettingsView` fetches the signed-in user on mount — keep it off the network.
vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    fetchMe: async () => ({
      email: "a@b.c",
      pro: false,
      proUntil: null,
      freeAiUsed: 0,
      freeAiLimit: 5,
    }),
    clearToken: () => {},
    deleteAccount: async () => ({ ok: true }),
    openPortal: async () => ({}),
  };
});

import SettingsView from "./SettingsView";
import LogsView from "./LogsView";
import type { Entitlement } from "./session";
import { setSpreadsheetId, clearSpreadsheetId, setRuntime } from "./googleSheets";

const SPREADSHEET_ID_KEY = "food-snap-sheets-spreadsheet-id";
const LAST_SYNC_KEY = "food-snap-sheets-last-sync";
const LAST_BACKUP_KEY = "food-snap-last-backup";
const SNOOZE_KEY = "food-snap-backup-snooze";

const NUDGE_TEXT = /Your log lives only on this device/i;

const entitlement: Entitlement = {
  pro: false,
  proUntil: null,
  freeAiUsed: 0,
  freeAiLimit: 5,
};

function checkin(id: string): DraftEvent {
  return { id, createdAt: Date.now(), type: "checkin", stress: "low" };
}

function renderSettings() {
  return render(
    <SettingsView
      entitlement={entitlement}
      onClose={() => {}}
      onUpgrade={() => {}}
      onSignedOut={() => {}}
      onChanged={() => {}}
    />,
  );
}

/** Let the mounted `fetchMe()` resolve before asserting, so no state lands late. */
async function settled() {
  await screen.findByText("a@b.c");
}

function renderLogs() {
  return render(
    <LogsView
      onEdit={() => {}}
      reloadKey={0}
      entitlement={entitlement}
      onUpgrade={() => {}}
      onOpenSettings={() => {}}
    />,
  );
}

beforeEach(() => {
  // Fresh persistence: disconnected, never synced, backup overdue and un-snoozed
  // so `isBackupDue(true)` is true unless a test says otherwise.
  localStorage.removeItem(SPREADSHEET_ID_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
  localStorage.removeItem(LAST_BACKUP_KEY);
  localStorage.removeItem(SNOOZE_KEY);
  h.store = [];
  setRuntime({ phase: "idle" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.removeItem(SPREADSHEET_ID_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
  localStorage.removeItem(LAST_BACKUP_KEY);
  localStorage.removeItem(SNOOZE_KEY);
  h.store = [];
  setRuntime({ phase: "idle" });
});

describe("SettingsView — Sheets controls follow the Client ID gate (Req 1.1, 1.2)", () => {
  it("renders no Google Sheets controls at all when no Client ID is configured", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");

    renderSettings();
    await settled();

    // The Data section rendered as usual…
    expect(screen.getByText("Back up data")).toBeTruthy();
    // …but nothing about Google Sheets: no sub-header, no Connect item (Req 1.1).
    expect(screen.queryAllByText(/Google Sheets/i)).toHaveLength(0);
    expect(screen.queryByText("Sync now")).toBeNull();
    expect(screen.queryByText("Disconnect")).toBeNull();
  });

  it("offers Connect while enabled and disconnected", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    clearSpreadsheetId();

    renderSettings();
    await settled();

    expect(screen.getByText("Connect Google Sheets")).toBeTruthy();
    expect(screen.getByText(/^Google Sheets ·/)).toBeTruthy();
    expect(screen.getByText("Google Sheets · Not connected")).toBeTruthy();
    // Connected-only actions stay hidden.
    expect(screen.queryByText("Sync now")).toBeNull();
  });

  it("offers Sync now / Re-import / Disconnect once connected", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    setSpreadsheetId("sheet-1");

    renderSettings();
    await settled();

    expect(screen.getByText("Sync now")).toBeTruthy();
    expect(screen.getByText("Re-import from Sheet")).toBeTruthy();
    expect(screen.getByText("Disconnect")).toBeTruthy();
    expect(screen.queryByText("Connect Google Sheets")).toBeNull();
    expect(screen.getByText("Google Sheets · Connected · not synced yet")).toBeTruthy();
  });
});

describe("LogsView — an active connection replaces the backup nudge (Req 8.1, 8.2)", () => {
  it("shows the nudge when a backup is due and Sheets is not connected", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    clearSpreadsheetId();
    h.store = [checkin("e1")];

    renderLogs();

    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
    expect(document.querySelector(".nudge")).toBeTruthy();
    expect(screen.getByText("Back up")).toBeTruthy();
    expect(screen.getByText("Later")).toBeTruthy();
  });

  it("suppresses the nudge when connected, even with a backup due (Req 8.1)", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    setSpreadsheetId("sheet-1");
    h.store = [checkin("e1")];

    renderLogs();

    // Wait for the timeline load to settle so we're not asserting on an empty render.
    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();
    expect(document.querySelector(".nudge")).toBeNull();
  });

  it("dismisses a shown nudge as soon as Sheets connects (Req 8.2)", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    clearSpreadsheetId();
    h.store = [checkin("e1")];

    renderLogs();
    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();

    // Connecting notifies subscribers — the view must drop the nudge immediately.
    await act(async () => {
      setSpreadsheetId("sheet-1");
    });

    await waitFor(() => expect(screen.queryByText(NUDGE_TEXT)).toBeNull());
    expect(document.querySelector(".nudge")).toBeNull();
  });
});
