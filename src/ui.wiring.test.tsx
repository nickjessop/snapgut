import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
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

const h = vi.hoisted(() => ({
  store: [] as DraftEvent[],
  /**
   * What `/api/me` answers with. `SettingsView` applies the Pro_Entitlement
   * snapshot the response carries (Req 1.7), so this is the *server's* view of
   * the entitlement and the tests keep it in step with the local snapshot
   * (`grantPro`) — except where the point is that the two disagree.
   */
  me: { pro: false, proUntil: null as number | null },
}));

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
      pro: h.me.pro,
      proUntil: h.me.proUntil,
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
import { setToken } from "./session";
import { setSpreadsheetId, clearSpreadsheetId, setRuntime } from "./googleSheets";
import {
  CLOUD_DATA_PATH,
  getSyncState,
  resetCloudSyncForTests,
} from "./cloudSync";
import {
  ackDisclosure,
  applyEntitlement,
  clearPersistedSyncSettingsForTests,
  getEntitlementSnapshot,
  hasAckedDisclosure,
  isDestinationEnabled,
  isProEntitled,
  recordSyncOutcome,
  resetSyncSettingsForTests,
  restore,
  setDestinationEnabled,
  FAILING_GRACE_MS,
} from "./syncSettings";

const SPREADSHEET_ID_KEY = "food-snap-sheets-spreadsheet-id";
const CLOUD_ENABLED_KEY = "snapgut-sync-cloud-enabled";
const LAST_SYNC_KEY = "food-snap-sheets-last-sync";
const LAST_BACKUP_KEY = "food-snap-last-backup";
const SNOOZE_KEY = "food-snap-backup-snooze";
const TOKEN_KEY = "snapgut-token";
const DAY_MS = 86_400_000;

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

let upgrades = 0;

function renderSettings() {
  return render(
    <SettingsView
      entitlement={entitlement}
      onClose={() => {}}
      onUpgrade={() => {
        upgrades += 1;
      }}
      onSignedOut={() => {}}
      onChanged={() => {}}
    />,
  );
}

/** The settings row whose title is `title`, as the clickable element itself. */
function row(title: string): HTMLElement {
  const el = screen.getByText(title).closest("button");
  if (!el) throw new Error(`no settings row titled "${title}"`);
  return el as HTMLElement;
}

/** The Sheets destination's own status line (Req 3.3). */
function sheetsStatus(): HTMLElement {
  const el = document.querySelector(".sheets-status");
  if (!el) throw new Error("no Sheets status line rendered");
  return el as HTMLElement;
}

/** The Cloud destination's own status line — a different element entirely. */
function cloudStatus(): HTMLElement {
  const el = document.querySelector(".cloud-status");
  if (!el) throw new Error("no Cloud status line rendered");
  return el as HTMLElement;
}

/** The non-colour state word on the Sheets line. */
function sheetsWord(): string {
  return sheetsStatus().querySelector(".cloud-state-word")?.textContent ?? "";
}

/** The non-colour state word on the Cloud line. */
function cloudWord(): string {
  return cloudStatus().querySelector(".cloud-state-word")?.textContent ?? "";
}

/** The Cloud line's message, beside the state word. */
function cloudMessage(): string {
  return cloudStatus().querySelector(".cloud-state-msg")?.textContent ?? "";
}

/** The Cloud destination toggle (Req 1.1, 1.2). */
function cloudToggle(): HTMLElement {
  return screen.getByRole("switch", { name: /Sync with SnapGut Cloud/i });
}

/** The action sheet currently on screen, if any. */
function sheet(): HTMLElement | null {
  return document.querySelector(".action-sheet");
}

/**
 * Replace `fetch` with a recorder that answers every request successfully, so a
 * step that must reach the Sync_Service can be shown to reach it and a step that
 * must not can be shown to issue nothing at all — at the transport, rather than
 * by trusting a stubbed module boundary.
 */
function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(
    async () =>
      new Response(JSON.stringify({ deleted: 2, records: [], cursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
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

/**
 * Grant Pro_Entitlement. Backup-nudge suppression now runs through the shared
 * predicate, which requires Pro on top of the enabled flag and the stored id
 * (cloud-sync Req 14.8, 15.2, 15.6).
 */
function grantPro(): void {
  // The server agrees, so the snapshot `SettingsView` applies from `/api/me`
  // (Req 1.7) confirms this one rather than contradicting it.
  h.me = { pro: true, proUntil: null };
  applyEntitlement({ pro: true, proUntil: null });
}

beforeEach(async () => {
  upgrades = 0;
  // Fresh persistence: disconnected, never synced, backup overdue and un-snoozed
  // so `isBackupDue(true)` is true unless a test says otherwise.
  localStorage.removeItem(SPREADSHEET_ID_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
  localStorage.removeItem(LAST_BACKUP_KEY);
  localStorage.removeItem(SNOOZE_KEY);
  // No Session_Token, so the Cloud destination is unconfigured until a test signs
  // in (cloud-sync Req 14.8).
  localStorage.removeItem(TOKEN_KEY);
  // Shared settings start from a clean, restored, fail-closed state: no
  // entitlement snapshot and both destinations disabled.
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  await restore();
  // A free plan until a test says otherwise, on the device and on the server.
  h.me = { pro: false, proUntil: null };
  h.store = [];
  setRuntime({ phase: "idle" });
  resetCloudSyncForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.removeItem(SPREADSHEET_ID_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
  localStorage.removeItem(LAST_BACKUP_KEY);
  localStorage.removeItem(SNOOZE_KEY);
  localStorage.removeItem(TOKEN_KEY);
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  h.me = { pro: false, proUntil: null };
  h.store = [];
  setRuntime({ phase: "idle" });
  resetCloudSyncForTests();
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
    grantPro();

    renderSettings();
    await settled();

    expect(screen.getByText("Connect Google Sheets")).toBeTruthy();
    expect(screen.getByText("Google Sheets")).toBeTruthy();
    expect(sheetsWord()).toBe("Not connected");
    // Connected-only actions stay hidden.
    expect(screen.queryByText("Sync to Sheets now")).toBeNull();
  });

  it("offers Sync / Re-import / Disconnect once connected", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    setSpreadsheetId("sheet-1");
    grantPro();

    renderSettings();
    await settled();

    expect(screen.getByText("Sync to Sheets now")).toBeTruthy();
    expect(screen.getByText("Re-import from Sheet")).toBeTruthy();
    expect(screen.getByText("Disconnect")).toBeTruthy();
    expect(screen.queryByText("Connect Google Sheets")).toBeNull();
    expect(sheetsWord()).toBe("Connected");
  });
});

// Task 15.2 — the Sheets block is Pro-gated and carries its own paused line.
//
// Validates: Requirements 3.3, 15.1, 15.3, 15.7, 15.8
describe("SettingsView — the Sheets block is Pro-gated (Req 15.1, 15.3)", () => {
  it("presents every Sheets control non-interactive with a separate upgrade control while not Pro", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    // Connected and switched on, but Pro is off.
    applyEntitlement({ pro: false, proUntil: null });
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");

    renderSettings();
    await settled();

    // Req 15.1 — every control is marked non-interactive…
    for (const title of ["Sync to Sheets now", "Re-import from Sheet", "Disconnect"]) {
      expect(row(title).getAttribute("aria-disabled")).toBe("true");
    }
    // …and activating one reaches nothing (no "Connecting…"/"Syncing…" busy toast,
    // so no Google request was started).
    await act(async () => {
      fireEvent.click(row("Sync to Sheets now"));
    });
    expect(screen.queryByText("Syncing…")).toBeNull();

    // Req 15.1 — the separate interactive control that opens the upgrade flow.
    const upgrade = row("Restore Pro to resume Sheets sync");
    expect(upgrade.getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      fireEvent.click(upgrade);
    });
    expect(upgrades).toBe(1);
  });

  it("presents the Sheets controls interactive while the destination is active (Req 15.3)", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    grantPro();
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");

    renderSettings();
    await settled();

    for (const title of ["Sync to Sheets now", "Re-import from Sheet", "Disconnect"]) {
      expect(row(title).getAttribute("aria-disabled")).toBeNull();
    }
    expect(screen.queryByText("Restore Pro to resume Sheets sync")).toBeNull();
  });
});

describe("SettingsView — the Sheets paused line (Req 15.8, 3.3)", () => {
  it("is distinguishable from not-connected and says what is retained", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    applyEntitlement({ pro: false, proUntil: Date.now() - 1000 });
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");

    renderSettings();
    await settled();

    expect(sheetsWord()).toBe("Paused");
    const msg = sheetsStatus().querySelector(".cloud-state-msg")?.textContent ?? "";
    expect(msg).toMatch(/paused/i);
    expect(msg).toMatch(/intact/i); // the logs are kept
    expect(msg).toMatch(/spreadsheet stays in Google Drive/i); // the sheet is kept
    expect(msg).toMatch(/Restore Pro/i); // how to get syncing back
  });

  it("appears on a lapse without touching the Cloud destination's line (Req 15.7, D6)", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    grantPro();
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");

    renderSettings();
    await settled();
    expect(sheetsWord()).toBe("Connected");
    // Two independent status lines, one per destination (Req 3.3).
    expect(document.querySelectorAll(".cloud-status, .sheets-status")).toHaveLength(2);

    // A Sheets sync failure leaves the Cloud line alone (Req 15.7).
    const cloudBefore = cloudStatus().textContent;
    await act(async () => {
      setRuntime({ phase: "error", message: "Sheets said no" });
    });
    expect(sheetsWord()).toBe("Error");
    expect(cloudStatus().textContent).toBe(cloudBefore);

    // And the lapse flips only the Sheets line into paused.
    await act(async () => {
      applyEntitlement({ pro: false, proUntil: Date.now() - 1000 });
    });
    expect(sheetsWord()).toBe("Paused");
  });
});

describe("LogsView — an active destination replaces the backup nudge (Req 8.1, 8.2; cloud-sync Req 15.6)", () => {
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

  it("suppresses the nudge when the Sheets destination is active, even with a backup due (Req 8.1)", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    // All four conditions of cloud-sync Req 15.2 hold, so the shared predicate
    // reports the destination active and suppresses the nudge.
    grantPro();
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");
    h.store = [checkin("e1")];

    renderLogs();

    // Wait for the timeline load to settle so we're not asserting on an empty render.
    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();
    expect(document.querySelector(".nudge")).toBeNull();
  });

  it("keeps showing the nudge when Sheets is connected but Pro is off (cloud-sync Req 15.2, 15.6)", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    // Enabled, configured, and holding a spreadsheet id — but not entitled, so the
    // destination is inactive and protects nothing. The nudge must stay.
    applyEntitlement({ pro: false, proUntil: null });
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");
    h.store = [checkin("e1")];

    renderLogs();

    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
    expect(document.querySelector(".nudge")).toBeTruthy();
  });

  it("dismisses a shown nudge as soon as the Sheets destination becomes active (Req 8.2)", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    clearSpreadsheetId();
    grantPro();
    h.store = [checkin("e1")];

    renderLogs();
    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();

    // A completed connect stores the spreadsheet id first and only then flips the
    // shared enabled flag (`connect()` orders it that way so a failed connect
    // enables nothing). The view observes `syncSettings`, which notifies on the
    // second step, so the nudge must go immediately.
    await act(async () => {
      setSpreadsheetId("sheet-1");
      setDestinationEnabled("sheets", true);
    });

    await waitFor(() => expect(screen.queryByText(NUDGE_TEXT)).toBeNull());
    expect(document.querySelector(".nudge")).toBeNull();
  });

  it("resumes the nudge when a Pro_Lapse makes the last destination inactive (cloud-sync Req 13.4, 15.6)", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    grantPro();
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");
    h.store = [checkin("e1")];

    renderLogs();
    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    await act(async () => {
      applyEntitlement({ pro: false, proUntil: null });
    });

    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
  });
});

// Task 15.6 — the nudge wiring across *both* destinations.
//
// The block above covers the Sheets side of the shared predicate. These close the
// remaining wiring gaps: suppression driven by the Cloud destination on its own,
// suppression holding while *either* destination is active, and the nudge resuming
// only once both are inactive — whatever makes them inactive.
//
// Validates: Requirements 14.2, 14.5
describe("LogsView — the shared predicate spans both destinations (Req 14.2, 14.5)", () => {
  /** Sign in and switch on the Cloud destination; Pro is granted separately. */
  function activateCloud(): void {
    setToken("t");
    setDestinationEnabled("cloud", true);
  }

  it("suppresses the nudge while only the Cloud destination is active (Req 14.2)", async () => {
    // Sheets is configured but holds no spreadsheet id, so it is inactive and
    // suppresses nothing — the Cloud destination is carrying the suppression.
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    clearSpreadsheetId();
    grantPro();
    activateCloud();
    h.store = [checkin("e1")];

    renderLogs();

    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();
    expect(document.querySelector(".nudge")).toBeNull();
  });

  it("suppresses it for an overdue backup with an expired snooze too (Req 14.2)", async () => {
    // Req 14.2 quantifies over the backup-timing state: a backup recorded 4 days
    // ago with a snooze that has already lapsed is squarely due, and stays
    // suppressed anyway.
    const now = Date.now();
    localStorage.setItem(LAST_BACKUP_KEY, String(now - 4 * DAY_MS));
    localStorage.setItem(SNOOZE_KEY, String(now - DAY_MS));
    grantPro();
    activateCloud();
    h.store = [checkin("e1")];

    renderLogs();

    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // …and the same timing state produces the nudge the moment nothing is active,
    // so the suppression left the stored timestamps alone (Req 14.5, 14.10).
    await act(async () => {
      setDestinationEnabled("cloud", false);
    });
    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
  });

  it("keeps suppression while either destination is active and resumes when both go inactive (Req 14.5)", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    grantPro();
    activateCloud();
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");
    h.store = [checkin("e1")];

    renderLogs();
    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // Only Sheets left active — still suppressed.
    await act(async () => {
      setDestinationEnabled("cloud", false);
    });
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // Back to Cloud only — still suppressed, so neither destination is special.
    await act(async () => {
      setDestinationEnabled("cloud", true);
      setDestinationEnabled("sheets", false);
    });
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // The last active destination goes inactive: the nudge comes back.
    await act(async () => {
      setDestinationEnabled("cloud", false);
    });
    await waitFor(() => expect(screen.queryByText(NUDGE_TEXT)).not.toBeNull());
    expect(document.querySelector(".nudge")).toBeTruthy();
  });

  it("resumes when the last destination goes inactive through continuous failure (Req 14.5, 14.9)", async () => {
    grantPro();
    activateCloud();
    h.store = [checkin("e1")];

    renderLogs();
    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // A failure with a success still inside the 72-hour window keeps the
    // destination active — it is protecting the data, just not right now.
    await act(async () => {
      const now = Date.now();
      recordSyncOutcome("cloud", "success", now - (FAILING_GRACE_MS - 60_000));
      recordSyncOutcome("cloud", "failure", now);
    });
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // Once that last success falls outside the window, the destination is inactive
    // and the nudge is the user's only protection again.
    await act(async () => {
      const now = Date.now();
      recordSyncOutcome("cloud", "success", now - (FAILING_GRACE_MS + 60_000));
      recordSyncOutcome("cloud", "failure", now);
    });
    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
  });

  it("resumes when the Cloud destination goes inactive through sign-out (Req 14.5, 14.8)", async () => {
    grantPro();
    activateCloud();
    h.store = [checkin("e1")];

    renderLogs();
    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // No Session_Token means the Cloud destination is unconfigured, whatever its
    // persisted enabled flag says. Removing the token notifies nobody by itself, so
    // the re-evaluation rides on the next settings notification — here a repeat of
    // the same entitlement, which leaves every other input of the predicate as it
    // was, isolating the token as the only condition that changed.
    await act(async () => {
      localStorage.removeItem(TOKEN_KEY);
      applyEntitlement({ pro: true, proUntil: null });
    });

    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
  });

  it("resumes when one Pro_Lapse deactivates both destinations at once (Req 14.5)", async () => {
    // Both destinations active, so neither one alone can account for the nudge
    // coming back: the shared entitlement gate is what deactivates both.
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    grantPro();
    activateCloud();
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");
    h.store = [checkin("e1")];

    renderLogs();
    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    await act(async () => {
      applyEntitlement({ pro: false, proUntil: Date.now() - 1000 });
    });

    // Both enabled flags and the spreadsheet id are untouched — the nudge is back
    // because neither destination is protecting anything (Req 14.5, 15.4).
    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
    expect(isDestinationEnabled("cloud")).toBe(true);
    expect(isDestinationEnabled("sheets")).toBe(true);
    expect(localStorage.getItem(SPREADSHEET_ID_KEY)).toBe("sheet-1");
  });
});

// Task 15.6 — the Cloud block's wiring, asserted against the transport.
//
// `settings.cloud.test.tsx` covers the same block with the three network-touching
// one-shots replaced by recorders. These tests keep the real `cloudSync` module
// and stub `fetch` instead, so "issues no request" is a claim about what leaves
// the device rather than about which module function was called.
//
// Validates: Requirements 1.1, 1.2, 1.7, 1.10, 15.7, 17.8, 18.9

describe("SettingsView — the Cloud toggle is locked without Pro (Req 1.1, 1.2, 1.10)", () => {
  it("is non-activatable, keeps its position, and reaches only the upgrade flow", async () => {
    // Signed in and persisted as enabled while Pro is off: the position shows the
    // persisted state, not the gate (Req 1.2), and the state is `blocked_no_pro`.
    setToken("t");
    setDestinationEnabled("cloud", true);
    const fetchMock = stubFetch();

    renderSettings();
    await settled();

    const toggle = cloudToggle();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // Non-activatable in the accessibility tree, but still a live target: Req 1.10
    // needs the activation to reach the upgrade flow, which a `disabled` control
    // could not do.
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(false);
    // Req 1.2 — the accompanying control that opens the upgrade flow is itself
    // interactive.
    const upgrade = row("Restore SnapGut Pro");
    expect(upgrade.getAttribute("aria-disabled")).toBeNull();

    // Everything the activation must leave alone, captured first.
    const stateBefore = JSON.stringify(getSyncState());
    const persistedBefore = localStorage.getItem(CLOUD_ENABLED_KEY);
    const reportedBefore = cloudStatus().textContent;

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(upgrades).toBe(1);
    // Req 1.10 — the persisted enabled state, the reported Sync_State, and the
    // toggle position are all exactly as they were, and nothing left the device.
    expect(localStorage.getItem(CLOUD_ENABLED_KEY)).toBe(persistedBefore);
    expect(isDestinationEnabled("cloud")).toBe(true);
    expect(JSON.stringify(getSyncState())).toBe(stateBefore);
    expect(cloudStatus().textContent).toBe(reportedBefore);
    expect(cloudToggle().getAttribute("aria-checked")).toBe("true");
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // The upgrade row beside it opens the same flow, which is the only thing an
    // unentitled user can reach here.
    await act(async () => {
      fireEvent.click(row("Restore SnapGut Pro"));
    });
    expect(upgrades).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("becomes activatable once /api/me reports Pro (Req 1.1, 1.7)", async () => {
    // The device holds no entitlement snapshot at all, so the gate fails closed
    // (Req 1.9) — and the server says the user is Pro.
    setToken("t");
    h.me = { pro: true, proUntil: null };
    expect(isProEntitled()).toBe(false);
    stubFetch();

    renderSettings();
    await settled();

    // Req 1.7, 1.8 — the snapshot the response carried is now the persisted one…
    expect(getEntitlementSnapshot()?.pro).toBe(true);
    expect(isProEntitled()).toBe(true);
    // …and the gate it feeds has already moved: Req 1.1's activatable toggle.
    expect(cloudToggle().getAttribute("aria-disabled")).toBeNull();
  });

  it("locks both destinations again when /api/me reports a lapse (Req 1.7, 15.8)", async () => {
    // A stale Pro snapshot on the device, both destinations switched on, and a
    // server that now says the entitlement is gone.
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    setToken("t");
    grantPro();
    setDestinationEnabled("cloud", true);
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");
    h.me = { pro: false, proUntil: null };
    stubFetch();

    renderSettings();
    await settled();

    expect(isProEntitled()).toBe(false);
    // The one response reaches both blocks: each line reads paused, each toggle
    // and control is locked, and both enabled flags are untouched.
    expect(cloudWord()).toBe("Paused");
    expect(sheetsWord()).toBe("Paused");
    expect(cloudToggle().getAttribute("aria-disabled")).toBe("true");
    expect(row("Sync to Sheets now").getAttribute("aria-disabled")).toBe("true");
    expect(isDestinationEnabled("cloud")).toBe(true);
    expect(isDestinationEnabled("sheets")).toBe(true);
  });
});

describe("SettingsView — the paused Cloud line retains the copy (Req 12.6, 13.10, D1)", () => {
  it("says the cloud copy is kept and shows no purge countdown", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    setToken("t");
    setDestinationEnabled("cloud", true);
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");
    stubFetch();

    renderSettings();
    await settled();

    expect(cloudWord()).toBe("Paused");
    const msg = cloudMessage();
    expect(msg).toMatch(/paused/i);
    expect(msg).toMatch(/intact/i);
    // Decision D1 is settled as retain-indefinitely: `daysUntilPurge` is
    // permanently `null`, so the line states the copy is kept and names no
    // deadline of any kind.
    const state = getSyncState();
    expect(state.state).toBe("blocked_no_pro");
    if (state.state === "blocked_no_pro") expect(state.daysUntilPurge).toBeNull();
    expect(msg).toMatch(/cloud copy is kept/i);
    expect(msg).not.toMatch(/day/i);
    expect(msg).not.toMatch(/deleted/i);

    // Req 15.7, D6 — the two "Paused" words sit in separate live regions and say
    // different things, so neither line is derived from the other.
    expect(sheetsWord()).toBe("Paused");
    expect(cloudStatus()).not.toBe(sheetsStatus());
    expect(cloudStatus().getAttribute("aria-live")).toBe("polite");
    expect(sheetsStatus().getAttribute("aria-live")).toBe("polite");
    expect(cloudMessage()).not.toBe(
      sheetsStatus().querySelector(".cloud-state-msg")?.textContent,
    );
  });
});

describe("SettingsView — the disclosure gates the first enable (Req 18.9)", () => {
  it("enables nothing and uploads nothing until the acknowledgement is activated", async () => {
    setToken("t");
    grantPro();
    const fetchMock = stubFetch();

    renderSettings();
    await settled();

    // Req 18.6 — the notice is on screen from the open alone. Closing it is not an
    // acknowledgement.
    expect(screen.getByText("What SnapGut Cloud stores")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Close"));
    });
    expect(sheet()).toBeNull();
    expect(hasAckedDisclosure("a@b.c")).toBe(false);

    await act(async () => {
      fireEvent.click(cloudToggle());
    });

    // Req 18.9 — the disclosure is shown again, the destination stays disabled,
    // nothing is persisted as enabled, and zero Log_Events have been uploaded.
    expect(screen.getByText("What SnapGut Cloud stores")).toBeTruthy();
    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(localStorage.getItem(CLOUD_ENABLED_KEY)).not.toBe("true");
    expect(cloudToggle().getAttribute("aria-checked")).toBe("false");
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Declining leaves it just as disabled.
    await act(async () => {
      fireEvent.click(screen.getByText("Not now"));
    });
    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Only the acknowledgement control completes the enable it gated.
    await act(async () => {
      fireEvent.click(cloudToggle());
    });
    await act(async () => {
      fireEvent.click(screen.getByText("I understand — turn on Cloud sync"));
    });

    expect(hasAckedDisclosure("a@b.c")).toBe(true);
    expect(isDestinationEnabled("cloud")).toBe(true);
    expect(localStorage.getItem(CLOUD_ENABLED_KEY)).toBe("true");
  });
});

describe("SettingsView — deleting the cloud copy needs the confirmation (Req 17.8)", () => {
  it("issues no request to the Sync_Service until the prompt is confirmed", async () => {
    setToken("t");
    grantPro();
    ackDisclosure("a@b.c");
    setDestinationEnabled("cloud", true);
    const fetchMock = stubFetch();

    renderSettings();
    await settled();
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await act(async () => {
      fireEvent.click(screen.getByText("Delete cloud copy"));
    });

    // Req 17.8 — the prompt states what is deleted and what is kept, and asking
    // for the deletion has issued nothing.
    const prompt = sheet();
    expect(prompt?.textContent).toMatch(/permanently deletes/i);
    expect(prompt?.textContent).toMatch(/copy on this device is kept/i);
    expect(prompt?.textContent).toMatch(/only on your other devices/i);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Backing out issues nothing either.
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await act(async () => {
      fireEvent.click(screen.getByText("Delete cloud copy"));
    });
    await act(async () => {
      fireEvent.click(document.querySelector(".action-sheet .action-item.danger") as HTMLElement);
    });

    // The confirmation is what issues the one request (Req 17.4).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(CLOUD_DATA_PATH);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});
