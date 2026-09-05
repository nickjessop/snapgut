import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { ONBOARDED_KEY } from "./Intro";

// Task 15.4 — startup and save-flow wiring in `App.tsx`.
//
// These are example (unit) tests over the shell's effect and its save flow,
// asserting the ordering and the funnels the requirements demand:
//   - the persisted destination state is restored before the first trigger, and
//     the tombstone sweep runs before it too (Req 3.9, 5.6, 11.2)
//   - exactly one `cold-launch` cycle per launch (Req 11.2)
//   - the ambient triggers are installed on mount and torn down on unmount
//     (Req 11.4, 11.9)
//   - saving a log triggers a `local-write` cycle (Req 11.1)
//
// Validates: Requirements 3.9, 5.6, 11.1, 11.2, 11.4, 11.9

const h = vi.hoisted(() => ({
  /** Every observed startup step, in the order the shell ran it. */
  steps: [] as string[],
  triggerTeardowns: 0,
  /** What `/api/me` answers: the endpoint returns the email and nothing else. */
  me: {
    email: "a@b.c",
  },
}));

// jsdom has no IndexedDB, so the two stores the shell touches are stubbed. The
// sweep records that it ran, which is what the ordering assertion reads.
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getEvents: async () => [],
    putEvent: async () => {},
    deleteEvent: async () => {},
    getOutboxCount: async () => 0,
    sweepTombstones: async () => {
      h.steps.push("sweep");
      return 0;
    },
  };
});

// The Cloud module's I/O is replaced by call recording: this test is about who
// calls what and in which order, not about what a cycle does.
vi.mock("./cloudSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cloudSync")>();
  return {
    ...actual,
    hydrateSyncState: async () => {
      h.steps.push("hydrate");
    },
    requestSync: async (reason: string) => {
      h.steps.push(`sync:${reason}`);
    },
    startTriggers: () => {
      h.steps.push("startTriggers");
      return () => {
        h.triggerTeardowns += 1;
      };
    },
  };
});

// `restore()` keeps its real behaviour — the ordering assertions observe the real
// restore, not a stub — and only reports that it ran.
vi.mock("./syncSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./syncSettings")>();
  return {
    ...actual,
    restore: async () => {
      await actual.restore();
      h.steps.push("restore");
    },
  };
});

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    getToken: () => "session-token",
    fetchMe: async () => ({ ...h.me }),
  };
});

import App from "./App";
import {
  clearPersistedSyncSettingsForTests,
  resetSyncSettingsForTests,
} from "./syncSettings";

/** The shell renders the tab bar only once the session check has settled. */
async function launched() {
  await screen.findByLabelText("Add log");
}

describe("App cloud startup wiring", () => {
  beforeEach(() => {
    h.steps = [];
    h.triggerTeardowns = 0;
    h.me = { email: "a@b.c" };
    localStorage.clear();
    localStorage.setItem(ONBOARDED_KEY, "1");
    resetSyncSettingsForTests();
    clearPersistedSyncSettingsForTests();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    resetSyncSettingsForTests();
  });

  it("restores settings and sweeps tombstones before the one cold-launch cycle", async () => {
    render(<App />);
    await launched();
    await waitFor(() => expect(h.steps).toContain("sync:cold-launch"));

    const restoreAt = h.steps.indexOf("restore");
    const sweepAt = h.steps.indexOf("sweep");
    const launchAt = h.steps.indexOf("sync:cold-launch");

    // Req 3.9 — restoration completes before the first cycle is triggered.
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    expect(restoreAt).toBeLessThan(launchAt);
    // Req 5.6 — expired tombstones go before the cycle, so a push never carries
    // rows the sweep is about to drop.
    expect(sweepAt).toBeGreaterThan(restoreAt);
    expect(sweepAt).toBeLessThan(launchAt);
    // Req 11.2 — exactly one Sync_Cycle for the launch.
    expect(h.steps.filter((s) => s === "sync:cold-launch")).toHaveLength(1);
  });

  it("installs the ambient triggers on mount and tears them down on unmount", async () => {
    const view = render(<App />);
    await launched();

    // Req 11.4, 11.9 — the `online` and foreground-return listeners are live.
    expect(h.steps).toContain("startTriggers");
    expect(h.triggerTeardowns).toBe(0);

    await act(async () => {
      view.unmount();
    });

    // No listener and no armed retry outlives this App instance.
    expect(h.triggerTeardowns).toBe(1);
  });

  it("triggers a local-write cycle when a log is saved", async () => {
    render(<App />);
    await launched();
    await waitFor(() => expect(h.steps).toContain("sync:cold-launch"));

    // Add log → Stress & sleep → pick a level → save.
    const add = await screen.findByLabelText("Add log");
    await act(async () => {
      add.click();
    });
    const openCheckin = await screen.findByText("Stress & sleep");
    await act(async () => {
      openCheckin.click();
    });
    const low = await screen.findByText("Low");
    await act(async () => {
      low.click();
    });
    const save = await screen.findByText("Save check-in");
    await act(async () => {
      save.click();
    });

    // Req 11.1 — the local write triggers exactly one Cloud cycle.
    await waitFor(() =>
      expect(h.steps.filter((s) => s === "sync:local-write")).toHaveLength(1),
    );
  });
});
