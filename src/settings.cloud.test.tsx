import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

// Task 15.1 — the SnapGut Cloud block in `SettingsView`.
//
// Example (unit) tests over the wired-up block. They assert the cloud sync
// toggle, disclosure gate, status line, and delete-confirmation flow.
//
// Validates: Requirements 10.2, 10.8, 11.3, 12.1, 12.3, 12.4, 12.10, 17.8, 18.6, 18.9

// ---- Local store stand-in (jsdom has no IndexedDB) ----

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getEvents: async () => [],
    getAllRecords: async () => [],
    getMeta: async () => undefined,
    setMeta: async () => {},
    getOutboxCount: async () => 0,
  };
});

// `SettingsView` fetches the signed-in user on mount — keep it off the network.
vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    fetchMe: async () => ({ email: "a@b.c" }),
    deleteAccount: async () => ({ ok: true }),
  };
});

// Only the operations that would reach the Sync_Service are recorded; the state
// store, its pub/sub, and the cycle markers stay real.
const cloud = vi.hoisted(() => ({
  requested: [] as string[],
  deleteCalls: 0,
  enqueueCalls: 0,
}));

vi.mock("./cloudSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cloudSync")>();
  return {
    ...actual,
    requestSync: async (reason: string) => {
      cloud.requested.push(reason);
    },
    deleteCloudCopy: async () => {
      cloud.deleteCalls += 1;
      return { ok: true as const, deleted: 3, localCleared: true };
    },
    enqueueEntireLocalStore: async () => {
      cloud.enqueueCalls += 1;
      return 0;
    },
  };
});

import SettingsView from "./SettingsView";
import { setToken, clearToken } from "./session";
import {
  markCycleStarted,
  markRestoreProgress,
  markCycleSucceeded,
  resetCloudSyncForTests,
} from "./cloudSync";
import {
  ackDisclosure,
  clearPersistedSyncSettingsForTests,
  hasAckedDisclosure,
  isDestinationEnabled,
  resetSyncSettingsForTests,
  restore,
  setDestinationEnabled,
} from "./syncSettings";

const EMAIL = "a@b.c";

function renderSettings() {
  return render(
    <SettingsView
      onClose={() => {}}
      onSignedOut={() => {}}
      onChanged={() => {}}
    />,
  );
}

/** Let the mounted `fetchMe()` and `hydrateSyncState()` land before asserting. */
async function settled() {
  await screen.findByText(EMAIL);
  await act(async () => {});
}

function cloudToggle(): HTMLElement {
  return screen.getByRole("switch", { name: /Sync with SnapGut Cloud/i });
}

function statusRegion(): HTMLElement {
  const el = document.querySelector(".cloud-status");
  if (!el) throw new Error("no cloud status line rendered");
  return el as HTMLElement;
}

/** The settings row whose title is `title`, as the clickable element itself. */
function row(title: string): HTMLElement {
  const el = screen.getByText(title).closest("button");
  if (!el) throw new Error(`no settings row titled "${title}"`);
  return el as HTMLElement;
}

/** The sheet currently on screen, if any. */
function sheet(): HTMLElement | null {
  return document.querySelector(".action-sheet");
}

beforeEach(async () => {
  cloud.requested = [];
  cloud.deleteCalls = 0;
  cloud.enqueueCalls = 0;
  localStorage.clear();
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  await restore();
  // A Session_Token is held, so Sync_State is not forced to `off`.
  setToken("t");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  clearToken();
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  localStorage.clear();
});

describe("SettingsView — the Cloud toggle is freely activatable (all features ungated)", () => {
  it("is activatable and enables the destination", async () => {
    ackDisclosure(EMAIL);

    renderSettings();
    await settled();

    const toggle = cloudToggle();
    expect(toggle.getAttribute("aria-disabled")).toBeNull();

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(isDestinationEnabled("cloud")).toBe(true);
    // The first enable queues the local timeline, then asks for a cycle.
    expect(cloud.requested).toEqual(["manual"]);
    expect(cloudToggle().getAttribute("aria-checked")).toBe("true");
  });

  it("takes its on/off position from the persisted state at mount and can be switched back off", async () => {
    ackDisclosure(EMAIL);
    // Persisted as enabled before the view ever mounts.
    setDestinationEnabled("cloud", true);

    renderSettings();
    await settled();

    const toggle = cloudToggle();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-disabled")).toBeNull();

    // Switching off is a local state change only: nothing is asked of the
    // Sync_Service.
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(cloudToggle().getAttribute("aria-checked")).toBe("false");
    expect(cloud.requested).toEqual([]);
    expect(cloud.deleteCalls).toBe(0);
  });
});

describe("SettingsView — the data disclosure gate (Req 18.6, 18.9)", () => {
  it("shows the disclosure on open with no further user action", async () => {
    renderSettings();
    await settled();

    expect(screen.getByText("What SnapGut Cloud stores")).toBeTruthy();
    // The categories that are uploaded, and that photos are not (Req 18.6).
    expect(screen.getByText(/Bristol stool scores/i)).toBeTruthy();
    expect(screen.getByText(/never leave this device/i)).toBeTruthy();
  });

  it("blocks the enable until the disclosure is acknowledged", async () => {
    renderSettings();
    await settled();

    // Close the on-open notice without acknowledging it.
    await act(async () => {
      fireEvent.click(screen.getByText("Close"));
    });
    expect(sheet()).toBeNull();
    expect(hasAckedDisclosure(EMAIL)).toBe(false);

    // Activating shows the disclosure again and enables nothing (Req 18.9).
    await act(async () => {
      fireEvent.click(cloudToggle());
    });
    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(cloud.requested).toEqual([]);
    const ack = screen.getByText("I understand — turn on Cloud sync");

    await act(async () => {
      fireEvent.click(ack);
    });
    expect(hasAckedDisclosure(EMAIL)).toBe(true);
    expect(isDestinationEnabled("cloud")).toBe(true);
    expect(cloud.requested).toEqual(["manual"]);
  });
});

describe("SettingsView — the status line surfaces Sync_State (Req 12.3, 12.10, 10.2, 10.8)", () => {
  beforeEach(() => {
    ackDisclosure(EMAIL);
    setDestinationEnabled("cloud", true);
  });

  it("is a polite live region carrying a non-colour state word", async () => {
    renderSettings();
    await settled();

    const region = statusRegion();
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    // The word, not the dot, carries the state (Req 12.10).
    expect(region.querySelector(".cloud-state-word")?.textContent).toBe("Waiting");
    expect(region.querySelector(".cloud-dot")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("reports the restore-in-progress count, then a dismissible summary", async () => {
    renderSettings();
    await settled();

    await act(async () => {
      markCycleStarted(true);
      markRestoreProgress(7);
    });

    expect(statusRegion().querySelector(".cloud-state-word")?.textContent).toBe("Syncing");
    // Req 10.2 — the merged-so-far count while an initial pull runs.
    expect(screen.getByText(/7 events merged so far/)).toBeTruthy();

    await act(async () => {
      await markCycleSucceeded(Date.UTC(2025, 0, 2, 3, 4), 0);
    });

    // Req 10.8 — the summary stays until the user dismisses it.
    expect(screen.getByText(/Restore complete · 7 events merged/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Dismiss"));
    });
    expect(screen.queryByText(/Restore complete/)).toBeNull();
    // Req 12.4 — `synced` keeps reporting the completion time.
    expect(statusRegion().querySelector(".cloud-state-word")?.textContent).toBe("Synced");
  });

  it("requests exactly one cycle per Sync now activation (Req 11.3)", async () => {
    renderSettings();
    await settled();

    await act(async () => {
      fireEvent.click(screen.getByText("Sync now"));
    });

    expect(cloud.requested).toEqual(["manual"]);
  });
});

describe("SettingsView — deleting the cloud copy needs confirmation (Req 17.8)", () => {
  it("issues no request until the user confirms in the prompt", async () => {
    ackDisclosure(EMAIL);
    setDestinationEnabled("cloud", true);

    renderSettings();
    await settled();

    await act(async () => {
      fireEvent.click(screen.getByText("Delete cloud copy"));
    });

    // The prompt is up and nothing has been asked of the Sync_Service yet.
    expect(cloud.deleteCalls).toBe(0);
    expect(screen.getByText("Delete the cloud copy?")).toBeTruthy();
    const prompt = sheet();
    expect(prompt?.textContent).toMatch(/permanently deletes/i);
    expect(prompt?.textContent).toMatch(/copy on this device is kept/i);
    expect(prompt?.textContent).toMatch(/only on your other devices/i);

    // Cancelling still issues nothing.
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"));
    });
    expect(cloud.deleteCalls).toBe(0);

    await act(async () => {
      fireEvent.click(screen.getByText("Delete cloud copy"));
    });
    const confirm = document.querySelector(".action-sheet .action-item.danger");
    await act(async () => {
      fireEvent.click(confirm as HTMLElement);
    });

    expect(cloud.deleteCalls).toBe(1);
  });
});
