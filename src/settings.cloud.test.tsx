import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

// Task 15.1 — the SnapGut Cloud block in `SettingsView`.
//
// Example (unit) tests over the wired-up block. They assert the gating and the
// surfacing the requirements demand at the UI level, driving the real
// `syncSettings` state and the real Sync_State derivation — only the three
// network-touching one-shots (`requestSync`, `deleteCloudCopy`,
// `enqueueEntireLocalStore`) are replaced by recorders, so a click that must
// issue no request can be shown to issue none.
//
// Task 15.6 extends the file with the wiring the block above left implicit: the
// upgrade affordance beside the locked toggle being interactive on its own, and a
// single Pro_Lapse pausing both destination lines independently.
//
// Validates: Requirements 1.1, 1.2, 1.10, 10.2, 10.8, 11.3, 12.1, 12.3, 12.4,
// 12.6, 12.10, 13.5, 15.1, 15.8, 17.8, 18.6, 18.9

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
//
// The response carries a Pro_Entitlement snapshot, which the mount effect applies
// through `syncSettings` (Req 1.7). So this stand-in answers with the snapshot the
// test established, read from the key `applyEntitlement` persists: the mount's
// application is then an idempotent echo of the test's own setup rather than a
// contradiction of it.
vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  const ENTITLEMENT_KEY = "snapgut-sync-entitlement";
  const persistedEntitlement = (): { pro: boolean; proUntil: number | null } => {
    try {
      const raw = localStorage.getItem(ENTITLEMENT_KEY);
      if (raw === null) return { pro: false, proUntil: null };
      const snap = JSON.parse(raw) as { pro?: unknown; proUntil?: unknown };
      return {
        pro: snap.pro === true,
        proUntil: typeof snap.proUntil === "number" ? snap.proUntil : null,
      };
    } catch {
      return { pro: false, proUntil: null };
    }
  };
  return {
    ...actual,
    fetchMe: async () => ({
      email: "a@b.c",
      ...persistedEntitlement(),
      freeAiUsed: 0,
      freeAiLimit: 5,
    }),
    openPortal: async () => ({}),
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
import type { Entitlement } from "./session";
import { setToken, clearToken } from "./session";
import { setSpreadsheetId, setRuntime } from "./googleSheets";
import {
  markCycleStarted,
  markRestoreProgress,
  markCycleSucceeded,
  resetCloudSyncForTests,
} from "./cloudSync";
import {
  ackDisclosure,
  applyEntitlement,
  clearPersistedSyncSettingsForTests,
  hasAckedDisclosure,
  isDestinationEnabled,
  resetSyncSettingsForTests,
  restore,
  setDestinationEnabled,
} from "./syncSettings";

const EMAIL = "a@b.c";

/** The free-plan entitlement prop; the Cloud gate reads `syncSettings`, not this. */
const entitlement: Entitlement = {
  pro: false,
  proUntil: null,
  freeAiUsed: 0,
  freeAiLimit: 5,
};

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

/** The Sheets destination's own status line — a different element entirely. */
function sheetsStatus(): HTMLElement {
  const el = document.querySelector(".sheets-status");
  if (!el) throw new Error("no Sheets status line rendered");
  return el as HTMLElement;
}

/** The non-colour state word on a status line. */
function word(line: HTMLElement): string {
  return line.querySelector(".cloud-state-word")?.textContent ?? "";
}

/** The message beside the state word on a status line. */
function message(line: HTMLElement): string {
  return line.querySelector(".cloud-state-msg")?.textContent ?? "";
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
  upgrades = 0;
  cloud.requested = [];
  cloud.deleteCalls = 0;
  cloud.enqueueCalls = 0;
  localStorage.clear();
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  await restore();
  // A Session_Token is held, so Sync_State is not forced to `off` by Req 1.6.
  setToken("t");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  clearToken();
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  setRuntime({ phase: "idle" });
  localStorage.clear();
});

describe("SettingsView — the Cloud toggle is Pro-gated (Req 1.1, 1.2, 1.10)", () => {
  it("shows a non-activatable toggle plus a separate upgrade row while not Pro", async () => {
    applyEntitlement({ pro: false, proUntil: null });

    renderSettings();
    await settled();

    const toggle = cloudToggle();
    // Req 1.2 — the position reflects the persisted state, and the control is
    // marked non-activatable in the accessibility tree.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    // Req 1.2 — a separate control opens the upgrade flow.
    expect(screen.getByText("Unlocks Cloud sync across your devices")).toBeTruthy();
  });

  // Task 15.6 — the upgrade affordance beside the locked toggle is itself
  // activatable, and activating it changes nothing about the destination.
  it("offers the upgrade affordance as an interactive row while the toggle is locked (Req 1.2)", async () => {
    applyEntitlement({ pro: false, proUntil: null });

    renderSettings();
    await settled();

    // Addressed by its own sub-line, since the plan section carries a row of the
    // same title.
    const upgrade = row("Unlocks Cloud sync across your devices");
    expect(upgrade.getAttribute("aria-disabled")).toBeNull();

    await act(async () => {
      fireEvent.click(upgrade);
    });

    expect(upgrades).toBe(1);
    // The affordance opens the flow only — it enables nothing and asks the
    // Sync_Service for nothing (Req 1.5, 18.7).
    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(cloudToggle().getAttribute("aria-checked")).toBe("false");
    expect(cloud.requested).toEqual([]);
  });

  it("leaves the persisted and reported state untouched and opens the upgrade flow (Req 1.10)", async () => {
    applyEntitlement({ pro: false, proUntil: null });
    ackDisclosure(EMAIL);

    renderSettings();
    await settled();

    const before = statusRegion().textContent;
    await act(async () => {
      fireEvent.click(cloudToggle());
    });

    expect(upgrades).toBe(1);
    expect(isDestinationEnabled("cloud")).toBe(false);
    expect(cloud.requested).toEqual([]);
    // The reported Sync_State is unchanged — still `off` (Req 12.1).
    expect(statusRegion().textContent).toBe(before);
    expect(cloudToggle().getAttribute("aria-checked")).toBe("false");
  });

  it("is activatable while Pro and enables the destination (Req 1.1, 11.3)", async () => {
    applyEntitlement({ pro: true, proUntil: null });
    ackDisclosure(EMAIL);

    renderSettings();
    await settled();

    const toggle = cloudToggle();
    expect(toggle.getAttribute("aria-disabled")).toBeNull();

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(isDestinationEnabled("cloud")).toBe(true);
    expect(upgrades).toBe(0);
    // The first enable queues the local timeline, then asks for a cycle.
    expect(cloud.requested).toEqual(["manual"]);
    expect(cloudToggle().getAttribute("aria-checked")).toBe("true");
  });

  it("takes its on/off position from the persisted state at mount and can be switched back off (Req 1.1)", async () => {
    applyEntitlement({ pro: true, proUntil: null });
    ackDisclosure(EMAIL);
    // Persisted as enabled before the view ever mounts.
    setDestinationEnabled("cloud", true);

    renderSettings();
    await settled();

    const toggle = cloudToggle();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-disabled")).toBeNull();

    // Switching off is a local state change only: nothing is asked of the
    // Sync_Service (Req 18.8).
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
    applyEntitlement({ pro: true, proUntil: null });

    renderSettings();
    await settled();

    expect(screen.getByText("What SnapGut Cloud stores")).toBeTruthy();
    // The categories that are uploaded, and that photos are not (Req 18.6).
    expect(screen.getByText(/Bristol stool scores/i)).toBeTruthy();
    expect(screen.getByText(/never leave this device/i)).toBeTruthy();
  });

  it("blocks the enable until the disclosure is acknowledged", async () => {
    applyEntitlement({ pro: true, proUntil: null });

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
    applyEntitlement({ pro: true, proUntil: null });
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

  it("shows the paused message and a restore-Pro row on a lapse (Req 12.6, 13.5)", async () => {
    renderSettings();
    await settled();

    await act(async () => {
      applyEntitlement({ pro: false, proUntil: Date.now() - 1000 });
    });

    const region = statusRegion();
    expect(region.querySelector(".cloud-state-word")?.textContent).toBe("Paused");
    const msg = region.querySelector(".cloud-state-msg")?.textContent ?? "";
    expect(msg).toMatch(/paused/i);
    expect(msg).toMatch(/intact/i);
    expect(msg).toMatch(/Restore Pro/i);
    // The toggle keeps its enabled position but is no longer activatable (Req 1.2, 13.3).
    expect(cloudToggle().getAttribute("aria-checked")).toBe("true");
    expect(cloudToggle().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Restore SnapGut Pro")).toBeTruthy();
  });
});

// Task 15.6 — one lapse, two paused lines.
//
// The Sheets paused line is covered on its own in `ui.wiring.test.tsx`; what is
// only observable with both destinations switched on is that a *single*
// Pro_Lapse pauses each line independently, each saying what its own destination
// retains, and each offering its own way back to Pro (D6).
//
// Validates: Requirements 12.6, 13.5, 15.1, 15.8
describe("SettingsView — a Pro lapse pauses both destination lines (Req 12.6, 15.8)", () => {
  it("shows a paused line per destination, each naming what it retains", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
    applyEntitlement({ pro: true, proUntil: null });
    ackDisclosure(EMAIL);
    setDestinationEnabled("cloud", true);
    setDestinationEnabled("sheets", true);
    setSpreadsheetId("sheet-1");

    renderSettings();
    await settled();

    // Two independent live regions, neither paused yet.
    expect(document.querySelectorAll(".cloud-status, .sheets-status")).toHaveLength(2);
    expect(word(statusRegion())).not.toBe("Paused");
    expect(word(sheetsStatus())).toBe("Connected");

    await act(async () => {
      applyEntitlement({ pro: false, proUntil: Date.now() - 1000 });
    });

    // Req 12.6, 15.8 — both lines flip to paused off the one lapse…
    expect(word(statusRegion())).toBe("Paused");
    expect(word(sheetsStatus())).toBe("Paused");

    // …and each message is about its own destination: the cloud copy is kept,
    // the spreadsheet is kept, and each says how to restore Pro.
    const cloudMsg = message(statusRegion());
    expect(cloudMsg).toMatch(/paused/i);
    expect(cloudMsg).toMatch(/intact/i);
    expect(cloudMsg).toMatch(/cloud copy is kept/i);
    expect(cloudMsg).toMatch(/Restore Pro/i);

    const sheetsMsg = message(sheetsStatus());
    expect(sheetsMsg).toMatch(/paused/i);
    expect(sheetsMsg).toMatch(/intact/i);
    expect(sheetsMsg).toMatch(/spreadsheet stays in Google Drive/i);
    expect(sheetsMsg).toMatch(/Restore Pro/i);
    // Neither line borrowed the other's wording (D6).
    expect(cloudMsg).not.toBe(sheetsMsg);

    // Req 1.2, 15.1 — each destination keeps its own upgrade control, and every
    // Sheets control is locked while the toggle keeps its enabled position.
    expect(row("Restore SnapGut Pro").getAttribute("aria-disabled")).toBeNull();
    expect(row("Restore Pro to resume Sheets sync").getAttribute("aria-disabled")).toBeNull();
    expect(row("Sync to Sheets now").getAttribute("aria-disabled")).toBe("true");
    expect(cloudToggle().getAttribute("aria-checked")).toBe("true");
    expect(cloudToggle().getAttribute("aria-disabled")).toBe("true");
    // Nothing was asked of either destination on the way through the lapse.
    expect(cloud.requested).toEqual([]);
  });
});

describe("SettingsView — deleting the cloud copy needs confirmation (Req 17.8)", () => {
  it("issues no request until the user confirms in the prompt", async () => {
    applyEntitlement({ pro: true, proUntil: null });
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
