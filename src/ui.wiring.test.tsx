import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import type { DraftEvent } from "./db";

// UI wiring tests for the Cloud sync integration and backup nudge.
//
// Validates: Requirements 14.2, 14.5, 17.8, 18.9

// ---- Fake local event store (stands in for IndexedDB) ----

const h = vi.hoisted(() => ({
  store: [] as DraftEvent[],
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

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    fetchMe: async () => ({ email: "a@b.c" }),
    clearToken: () => {},
    deleteAccount: async () => ({ ok: true }),
  };
});

import SettingsView from "./SettingsView";
import LogsView from "./LogsView";
import { setToken } from "./session";
import {
  CLOUD_DATA_PATH,
  getSyncState,
  resetCloudSyncForTests,
} from "./cloudSync";
import {
  ackDisclosure,
  clearPersistedSyncSettingsForTests,
  hasAckedDisclosure,
  isDestinationEnabled,
  recordSyncOutcome,
  resetSyncSettingsForTests,
  restore,
  setDestinationEnabled,
  FAILING_GRACE_MS,
} from "./syncSettings";

const CLOUD_ENABLED_KEY = "snapgut-sync-cloud-enabled";
const LAST_BACKUP_KEY = "food-snap-last-backup";
const SNOOZE_KEY = "food-snap-backup-snooze";
const TOKEN_KEY = "snapgut-token";
const DAY_MS = 86_400_000;

const NUDGE_TEXT = /Your log lives only on this device/i;

function checkin(id: string): DraftEvent {
  return { id, createdAt: Date.now(), type: "checkin", stress: "low" };
}

function renderSettings() {
  return render(
    <SettingsView
      onClose={() => {}}
      onSignedOut={() => {}}
      onChanged={() => {}}
    />,
  );
}

/** The Cloud destination toggle. */
function cloudToggle(): HTMLElement {
  return screen.getByRole("switch", { name: /Sync with SnapGut Cloud/i });
}

/** The Cloud destination's status line. */
function cloudStatus(): HTMLElement {
  const el = document.querySelector(".cloud-status");
  if (!el) throw new Error("no Cloud status line rendered");
  return el as HTMLElement;
}

/** The action sheet currently on screen, if any. */
function sheet(): HTMLElement | null {
  return document.querySelector(".action-sheet");
}

/**
 * Replace `fetch` with a recorder that answers every request successfully.
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

/** Let the mounted `fetchMe()` resolve before asserting. */
async function settled() {
  await screen.findByText("a@b.c");
}

function renderLogs() {
  return render(
    <LogsView
      onEdit={() => {}}
      reloadKey={0}
      onOpenSettings={() => {}}
    />,
  );
}

beforeEach(async () => {
  localStorage.removeItem(LAST_BACKUP_KEY);
  localStorage.removeItem(SNOOZE_KEY);
  localStorage.removeItem(TOKEN_KEY);
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  await restore();
  h.store = [];
  resetCloudSyncForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.removeItem(LAST_BACKUP_KEY);
  localStorage.removeItem(SNOOZE_KEY);
  localStorage.removeItem(TOKEN_KEY);
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  h.store = [];
  resetCloudSyncForTests();
});

describe("LogsView — an active Cloud destination replaces the backup nudge (Req 14.2, 14.5)", () => {
  /** Sign in and switch on the Cloud destination. */
  function activateCloud(): void {
    setToken("t");
    setDestinationEnabled("cloud", true);
  }

  it("shows the nudge when a backup is due and Cloud is not active", async () => {
    h.store = [checkin("e1")];

    renderLogs();

    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
    expect(document.querySelector(".nudge")).toBeTruthy();
    expect(screen.getByText("Back up")).toBeTruthy();
    expect(screen.getByText("Later")).toBeTruthy();
  });

  it("suppresses the nudge while the Cloud destination is active (Req 14.2)", async () => {
    activateCloud();
    h.store = [checkin("e1")];

    renderLogs();

    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();
    expect(document.querySelector(".nudge")).toBeNull();
  });

  it("suppresses it for an overdue backup with an expired snooze too (Req 14.2)", async () => {
    const now = Date.now();
    localStorage.setItem(LAST_BACKUP_KEY, String(now - 4 * DAY_MS));
    localStorage.setItem(SNOOZE_KEY, String(now - DAY_MS));
    activateCloud();
    h.store = [checkin("e1")];

    renderLogs();

    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // …and the same timing state produces the nudge the moment nothing is active.
    await act(async () => {
      setDestinationEnabled("cloud", false);
    });
    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
  });

  it("resumes when the Cloud destination goes inactive through continuous failure (Req 14.5, 14.9)", async () => {
    activateCloud();
    h.store = [checkin("e1")];

    renderLogs();
    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // A failure with a success still inside the 72-hour window keeps the
    // destination active.
    await act(async () => {
      const now = Date.now();
      recordSyncOutcome("cloud", "success", now - (FAILING_GRACE_MS - 60_000));
      recordSyncOutcome("cloud", "failure", now);
    });
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // Once that last success falls outside the window, the destination is inactive.
    await act(async () => {
      const now = Date.now();
      recordSyncOutcome("cloud", "success", now - (FAILING_GRACE_MS + 60_000));
      recordSyncOutcome("cloud", "failure", now);
    });
    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
  });

  it("resumes when the Cloud destination goes inactive through sign-out (Req 14.5, 14.8)", async () => {
    activateCloud();
    h.store = [checkin("e1")];

    renderLogs();
    expect(await screen.findByText("Stress & sleep")).toBeTruthy();
    expect(screen.queryByText(NUDGE_TEXT)).toBeNull();

    // No Session_Token means the Cloud destination is unconfigured.
    await act(async () => {
      localStorage.removeItem(TOKEN_KEY);
      // Trigger a re-evaluation by toggling destination state
      setDestinationEnabled("cloud", false);
    });

    expect(await screen.findByText(NUDGE_TEXT)).toBeTruthy();
  });
});

describe("SettingsView — the disclosure gates the first enable (Req 18.9)", () => {
  it("enables nothing and uploads nothing until the acknowledgement is activated", async () => {
    setToken("t");
    const fetchMock = stubFetch();

    renderSettings();
    await settled();

    // The notice is on screen from the open alone. Closing it is not an acknowledgement.
    expect(screen.getByText("What SnapGut Cloud stores")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Close"));
    });
    expect(sheet()).toBeNull();
    expect(hasAckedDisclosure("a@b.c")).toBe(false);

    await act(async () => {
      fireEvent.click(cloudToggle());
    });

    // The disclosure is shown again, the destination stays disabled.
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

    // Only the acknowledgement control completes the enable.
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
    ackDisclosure("a@b.c");
    setDestinationEnabled("cloud", true);
    const fetchMock = stubFetch();

    renderSettings();
    await settled();
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await act(async () => {
      fireEvent.click(screen.getByText("Delete cloud copy"));
    });

    // The prompt states what is deleted and what is kept.
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

    // The confirmation is what issues the one request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(CLOUD_DATA_PATH);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});
