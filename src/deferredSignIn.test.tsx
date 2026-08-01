// Deferred sign-in: what an anonymous visitor can do, and where they are asked
// for an email.
//
// The point of the change is that the gate moved from the app's front door to the
// two places that genuinely need a session — `/api/recognize` and `/api/insights`.
// So the assertions come in pairs: the local thing works without an account, and
// the server thing offers sign-in instead of firing a request that would 401.
//
// `src/routing.client.test.tsx` covers the routing half (no redirect to /login).
// This file covers the call sites and the counters.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { ONBOARDED_KEY } from "./Intro";
import { DEFAULT_APP_PATH } from "../shared/site.js";

const h = vi.hoisted(() => ({
  /** The held Session_Token, or `null` for a signed-out device. */
  token: null as string | null,
  /** Events the timeline reports, so Insights has something to summarise. */
  events: [] as unknown[],
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getEvents: async () => h.events,
    putEvent: async () => {},
    deleteEvent: async () => {},
    getOutboxCount: async () => 0,
    sweepTombstones: async () => 0,
  };
});

vi.mock("./cloudSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cloudSync")>();
  return {
    ...actual,
    hydrateSyncState: async () => {},
    requestSync: async () => {},
    startTriggers: () => () => {},
  };
});

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    getToken: () => h.token,
    fetchMe: async () =>
      h.token
        ? { email: "a@b.c", pro: false, proUntil: null, freeAiUsed: 0, freeAiLimit: 10 }
        : null,
    clearToken: () => {},
  };
});

import App from "./App";
import { countLogSaved } from "./metrics";

/** Every URL fetched during a test, so "no AI request was made" is checkable. */
let calls: string[] = [];

function bootAt(path: string) {
  window.history.pushState(null, "", path);
  return render(<App />);
}

async function shell(): Promise<void> {
  await screen.findByLabelText("Add log");
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
  });
}

beforeEach(() => {
  h.token = null;
  h.events = [];
  calls = [];
  localStorage.clear();
  localStorage.setItem(ONBOARDED_KEY, "1");

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("what works with no account", () => {
  it("opens the app at the default view", async () => {
    bootAt(DEFAULT_APP_PATH);
    await shell();

    // No sign-in form, no paywall, no redirect — just the app.
    expect(screen.queryByText("Sign in to SnapGut")).toBeNull();
    expect(window.location.pathname + window.location.search).toBe(DEFAULT_APP_PATH);
  });

  it("makes no `/api/recognize` or `/api/insights` request at boot", async () => {
    bootAt(DEFAULT_APP_PATH);
    await shell();

    // A signed-out boot used to be impossible; now it must be quiet. Anything
    // that needs a session would answer 401 and route the visitor to /login,
    // which is the exact bounce this change removes.
    expect(calls.some((u) => u.includes("/api/recognize"))).toBe(false);
    expect(calls.some((u) => u.includes("/api/insights"))).toBe(false);
  });

  it("reaches every log flow from the add sheet", async () => {
    bootAt(DEFAULT_APP_PATH);
    await shell();

    await click(screen.getByLabelText("Add log"));
    // All four are local writes to IndexedDB, so none of them needs an account.
    for (const label of ["Symptom", "Bowel movement", "Stress & sleep"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows on-device insights and offers sign-in only for the narrative", async () => {
    h.events = [
      { id: "1", type: "meal", createdAt: Date.now() - 7200_000, dish: "Toast", ingredients: [] },
      { id: "2", type: "symptom", createdAt: Date.now() - 3600_000, symptoms: ["bloating"] },
    ];
    bootAt("/app/insights");
    await shell();

    // The stats are computed locally, so they are visible without an account —
    // and the AI block asks for sign-in rather than for money, because an
    // anonymous visitor still has their whole free AI trial ahead of them.
    await screen.findByText("AI insight");
    expect(screen.getByText("Sign in to use AI")).toBeTruthy();
    expect(screen.queryByText("Unlock Pro")).toBeNull();
  });
});

describe("where the account is asked for", () => {
  it("raises the sign-in prompt from the insights AI block", async () => {
    h.events = [
      { id: "1", type: "meal", createdAt: Date.now() - 7200_000, dish: "Toast", ingredients: [] },
      { id: "2", type: "symptom", createdAt: Date.now() - 3600_000, symptoms: ["bloating"] },
    ];
    bootAt("/app/insights");
    await shell();

    await click(await screen.findByText("Sign in to use AI"));

    // The prompt says why it appeared, and offers a way out — the visitor came to
    // read their patterns, not to make an account.
    await screen.findByText("Sign in to use AI", { selector: "h1" });
    expect(screen.getByText("Not now")).toBeTruthy();
    // The URL is untouched: this is a screen raised over the view, not a route.
    expect(window.location.pathname).toBe("/app/insights");
  });

  it("returns to the app when the prompt is declined", async () => {
    h.events = [
      { id: "1", type: "meal", createdAt: Date.now() - 7200_000, dish: "Toast", ingredients: [] },
      { id: "2", type: "symptom", createdAt: Date.now() - 3600_000, symptoms: ["bloating"] },
    ];
    bootAt("/app/insights");
    await shell();
    await click(await screen.findByText("Sign in to use AI"));

    await click(await screen.findByText("Not now"));

    // Back where they were, still signed out, nothing lost.
    await shell();
    expect(window.location.pathname).toBe("/app/insights");
  });

  it("offers sign-in rather than Pro in Settings", async () => {
    bootAt("/app/settings");
    await screen.findByRole("heading", { name: "Settings" });

    // No account means nothing to sell and nothing to manage. Offering "Upgrade
    // to Pro" here would ask for money to solve a problem an email address fixes.
    expect(screen.getByText("Not signed in")).toBeTruthy();
    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.queryByText("Upgrade to SnapGut Pro")).toBeNull();
    // Neither control means anything without a session.
    expect(screen.queryByText("Sign out")).toBeNull();
    expect(screen.queryByText("Delete account & data")).toBeNull();
  });
});

describe("the log counters", () => {
  it("reports first_log once per device and log_saved every time", async () => {
    countLogSaved();
    countLogSaved();
    countLogSaved();

    const posted = calls.filter((u) => u.includes("/api/metrics"));
    // Three saves, three ticks — but only the first is also a first log, because
    // "did an anonymous visitor ever log anything" is a conversion, not a rate.
    expect(posted).toHaveLength(4);

    const bodies = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls.map(([, init]) => String(init?.body));
    expect(bodies.filter((b) => b.includes("first_log"))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes("log_saved"))).toHaveLength(3);
  });

  it("sends no identifier with a tick", async () => {
    countLogSaved();

    const [, init] = (
      globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }
    ).mock.calls[0];
    // The event name and the build id, and nothing else. The build is shared by
    // every client on a deploy, so it names a release rather than a person — and it
    // is the only extra field allowed here. No device id, no session, no timestamp,
    // so two ticks still cannot be known to share a device.
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body).sort()).toEqual(["build", "event"]);
    expect(body.event).toBe("log_saved");
    expect(body.build).toBe("0.0.0-test");
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("never throws when the network is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );

    // A counter that can break a save is worse than no counter at all.
    expect(() => countLogSaved()).not.toThrow();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  });
});
