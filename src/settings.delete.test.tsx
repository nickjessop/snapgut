import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

// Task 15.5 — `reallyDelete()` and the account-deletion cleanup in
// `SettingsView`.
//
// Example (unit) tests over the wired-up flow. The only thing replaced is the
// server call itself, so what the component does to this device — the
// Local_Store database, the persisted Sync_Settings, the Sheets spreadsheet id,
// and the Session_Token — is observed for real.
//
// Validates: Requirements 17.3, 17.7, 17.9

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

const server = vi.hoisted(() => ({
  deleteCalls: 0,
  mode: "success" as "success" | "error" | "hang",
}));

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    fetchMe: async () => ({
      email: "a@b.c",
    }),
    deleteAccount: (): Promise<{ ok: boolean }> => {
      server.deleteCalls += 1;
      if (server.mode === "error") return Promise.reject(new Error("server_error"));
      if (server.mode === "hang") return new Promise(() => {});
      return Promise.resolve({ ok: true });
    },
  };
});

// Nothing here should reach the Sync_Service; the state store stays real.
vi.mock("./cloudSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cloudSync")>();
  return {
    ...actual,
    requestSync: async () => {},
    deleteCloudCopy: async () => ({ ok: true as const, deleted: 0, localCleared: true }),
    enqueueEntireLocalStore: async () => 0,
  };
});

import SettingsView from "./SettingsView";
import { getToken, setToken, clearToken } from "./session";
import { resetCloudSyncForTests } from "./cloudSync";
import {
  ackDisclosure,
  clearPersistedSyncSettingsForTests,
  resetSyncSettingsForTests,
  restore,
  setDestinationEnabled,
} from "./syncSettings";

const EMAIL = "a@b.c";

let signedOut = 0;
let deleted: string[] = [];

function renderSettings() {
  return render(
    <SettingsView
      onClose={() => {}}
      onSignedOut={() => {
        signedOut += 1;
      }}
      onChanged={() => {}}
    />,
  );
}

async function settled() {
  await screen.findByText(EMAIL);
  await act(async () => {});
}

/** Walk the confirmation prompt of the "Delete account & data" row. */
async function confirmAccountDelete() {
  await act(async () => {
    fireEvent.click(screen.getByText("Delete account & data"));
  });
  expect(screen.getByText("Delete account & all data?")).toBeTruthy();
  const confirm = document.querySelector(".action-sheet .action-item.danger");
  await act(async () => {
    fireEvent.click(confirm as HTMLElement);
  });
}

/** Everything this device holds that a successful deletion has to clear. */
function localState() {
  return {
    dbDeleted: deleted,
    backupKey: localStorage.getItem("food-snap-last-backup"),
    token: getToken(),
  };
}

beforeEach(async () => {
  signedOut = 0;
  deleted = [];
  server.deleteCalls = 0;
  server.mode = "success";
  localStorage.clear();
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  await restore();

  // A device mid-life: signed in, syncing, with a backup
  // reminder recorded under the `food-snap` prefix.
  setToken("t");
  ackDisclosure(EMAIL);
  setDestinationEnabled("cloud", true);
  localStorage.setItem("food-snap-last-backup", "123");

  // jsdom has no IndexedDB, so the wipe target is observed through a stub.
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    deleteDatabase: (name: string) => {
      deleted.push(name);
      return {};
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
  clearToken();
  resetCloudSyncForTests();
  resetSyncSettingsForTests();
  clearPersistedSyncSettingsForTests();
  localStorage.clear();
});

describe("SettingsView — a successful account deletion wipes this device (Req 17.3, 17.9)", () => {
  it("clears the local database, the persisted keys, and the token, then signs out", async () => {
    renderSettings();
    await settled();

    await confirmAccountDelete();

    // Req 17.3 — the Local_Store, the Outbox, and the Sync_Cursor all live in the
    // one database, and every `food-snap` / `snapgut` key is swept.
    expect(deleted).toEqual(["food-snap"]);
    expect(localStorage.getItem("food-snap-last-backup")).toBeNull();
    expect(
      Object.keys(localStorage).filter(
        (k) => k.startsWith("food-snap") || k.startsWith("snapgut"),
      ),
    ).toEqual([]);
    expect(getToken()).toBeNull();
    expect(signedOut).toBe(1);
  });
});

describe("SettingsView — a failed account deletion changes nothing locally (Req 17.7)", () => {
  it("retains the data, the settings, and the token, and offers a retry control", async () => {
    server.mode = "error";

    renderSettings();
    await settled();

    await confirmAccountDelete();

    // Req 17.7 — no part of the wipe ran.
    expect(localState()).toEqual({
      dbDeleted: [],
      backupKey: "123",
      token: "t",
    });
    expect(signedOut).toBe(0);
    // The message says the account was not deleted, and exactly one request was
    // issued — nothing retries on its own.
    expect(screen.getByText(/account wasn't deleted/i)).toBeTruthy();
    expect(server.deleteCalls).toBe(1);

    // The retry control repeats the request, and only when the user drives it.
    await act(async () => {
      fireEvent.click(screen.getByText("Try deleting the account again"));
    });
    expect(server.deleteCalls).toBe(1);
    const confirm = document.querySelector(".action-sheet .action-item.danger");
    await act(async () => {
      fireEvent.click(confirm as HTMLElement);
    });
    expect(server.deleteCalls).toBe(2);
  });

  it("clears nothing while the request is outstanding, and treats 30s as a failure", async () => {
    server.mode = "hang";

    renderSettings();
    await settled();

    vi.useFakeTimers();
    await confirmAccountDelete();

    // Req 17.3 — no part of the clearing happens before a success status.
    expect(localState()).toEqual({
      dbDeleted: [],
      backupKey: "123",
      token: "t",
    });
    expect(signedOut).toBe(0);

    // Req 17.7 — a request still outstanding at 30s is reported as a failure,
    // with the device still untouched.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await act(async () => {});

    expect(screen.getByText(/account wasn't deleted/i)).toBeTruthy();
    expect(localState()).toEqual({
      dbDeleted: [],
      backupKey: "123",
      token: "t",
    });
    expect(signedOut).toBe(0);
  });
});
