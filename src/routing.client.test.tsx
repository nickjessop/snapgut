// Task 3.4 — client routing tests.
//
// These are example (behavioural) tests over the whole client routing stack:
// `src/routes.ts` (pure mapping), `src/useRouter.ts` (the history binding), and
// the boot-order ladder in `src/App.tsx`. They drive the real `window.history`
// in jsdom rather than a stub, so "adds exactly one entry" and "a back gesture
// cancels the flow" are claims about the browser API the app actually uses.
//
// What is asserted:
//   - boot at the Login_Route and at each App_Route, with and without a
//     Session_Token, produces the redirect outcome the requirements name, and
//     every boot redirect *replaces* rather than adds an entry (Req 3.1, 3.2, 3.3)
//   - switching Addressable_View adds exactly one history entry (Req 4.2)
//   - a backward navigation while an Ephemeral_Flow is open runs the flow's
//     cancel path and stays inside the App_Shell (Req 4.6)
//   - a boot at an App_Route activates zero Ephemeral_Flows (Req 4.8)
//
// Validates: Requirements 3.1, 3.2, 3.3, 4.2, 4.6, 4.8

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { ONBOARDED_KEY } from "./Intro";
import { APP_VIEWS, DEFAULT_APP_PATH, LOGIN_PATH, isAppPath } from "../shared/site.js";

const h = vi.hoisted(() => ({
  /** The held Session_Token, or `null` for a signed-out device. */
  token: "session-token" as string | null,
}));

// jsdom has no IndexedDB. The shell touches the store on mount (the tombstone
// sweep) and `LogsView`/`InsightsView` read the timeline, so both are stubbed —
// this file is about URLs, not about persistence.
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getEvents: async () => [],
    putEvent: async () => {},
    deleteEvent: async () => {},
    getOutboxCount: async () => 0,
    sweepTombstones: async () => 0,
  };
});

// The Cloud destination's I/O is irrelevant here and must not reach the network.
vi.mock("./cloudSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cloudSync")>();
  return {
    ...actual,
    hydrateSyncState: async () => {},
    requestSync: async () => {},
    startTriggers: () => () => {},
  };
});

// The session is the single input to the route guard, so it is the one thing
// these tests vary.
vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    getToken: () => h.token,
    fetchMe: async () => (h.token ? { email: "a@b.c" } : null),
    clearToken: () => {},
  };
});

import App from "./App";

// Captured before any spy is installed, so the recorders below drive the real
// session history rather than each other.
const realPush = window.history.pushState.bind(window.history);
const realReplace = window.history.replaceState.bind(window.history);

/** Every URL the app pushed, in order — one entry added per call. */
let pushed: string[] = [];
/** Every URL the app replaced the current entry with, in order. */
let replaced: string[] = [];

/** The address of the current entry, in the form the router writes. */
function url(): string {
  return window.location.pathname + window.location.search;
}

/**
 * Put the browser at `path` and mount the app there. `pushState` rather than
 * `replaceState` so any forward entry left by an earlier test is pruned and a
 * later `history.back()` lands on this boot entry.
 */
function bootAt(path: string) {
  realPush(null, "", path);
  pushed = [];
  replaced = [];
  return render(<App />);
}

/** Wait until the session check has settled and the tab shell is on screen. */
async function shell(): Promise<void> {
  await screen.findByLabelText("Add log");
}

/** True while the tab shell is rendered — which only happens with no flow open. */
function inTabShell(): boolean {
  return document.querySelector(".tabbar") !== null;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
  });
}

/** A real backward history navigation, awaited to its `popstate`. */
async function goBack(): Promise<void> {
  await act(async () => {
    const fired = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true })
    );
    window.history.back();
    await fired;
  });
}

beforeEach(() => {
  h.token = "session-token";
  pushed = [];
  replaced = [];
  localStorage.clear();
  // The first-run intro is a separate gate; these tests are about what comes
  // after it.
  localStorage.setItem(ONBOARDED_KEY, "1");

  vi.spyOn(window.history, "pushState").mockImplementation(((
    state: unknown,
    title: string,
    to?: string | URL | null
  ) => {
    pushed.push(String(to));
    realPush(state, title, to);
  }) as typeof window.history.pushState);

  vi.spyOn(window.history, "replaceState").mockImplementation(((
    state: unknown,
    title: string,
    to?: string | URL | null
  ) => {
    replaced.push(String(to));
    realReplace(state, title, to);
  }) as typeof window.history.replaceState);

  // Nothing here should reach the network; a request would be a bug, not a fixture.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    )
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("boot while a Session_Token is held (Req 3.1, 3.3)", () => {
  it("replaces the Login_Route with the default App_Route, adding no entry", async () => {
    bootAt(LOGIN_PATH);
    await shell();

    // R3.1 — the session belongs in the app, and the redirect replaces the entry
    // it was on, so there is nothing to go back to.
    await waitFor(() => expect(url()).toBe(DEFAULT_APP_PATH));
    expect(pushed).toEqual([]);
    expect(replaced).toContain(DEFAULT_APP_PATH);
  });

  it("returns to the App_Route named by next", async () => {
    bootAt(`${LOGIN_PATH}?next=%2Fapp%2Finsights`);
    await shell();

    // R3.3 — the parameter names where sign-in was interrupted.
    await waitFor(() => expect(url()).toBe("/app/insights"));
    expect(pushed).toEqual([]);
  });

  it("falls back to the default App_Route for a next that leaves the app", async () => {
    bootAt(`${LOGIN_PATH}?next=https%3A%2F%2Fevil.com%2Fapp`);
    await shell();

    // R3.3, R3.4 — an unrecognised `next` collapses to the default view, and no
    // navigation to another origin happens.
    await waitFor(() => expect(url()).toBe(DEFAULT_APP_PATH));
    expect(window.location.origin).toBe("http://localhost:3000");
  });

  it.each(APP_VIEWS.map((v) => v.path))(
    "keeps the App_Route it booted at: %s",
    async (path) => {
      bootAt(path);
      // `/app/settings` renders the settings view instead of the tab shell.
      if (path === "/app/settings") await screen.findByRole("heading", { name: "Settings" });
      else await shell();

      // R4.1 — each Addressable_View is reachable by loading its App_Route, and a
      // held session means no redirect at all.
      expect(url()).toBe(path);
      expect(pushed).toEqual([]);
    }
  );

  it("renders the view the App_Route maps to", async () => {
    bootAt("/app/insights");
    await shell();

    // `/app/insights` is the insights tab, not the default camera view.
    expect(document.querySelector(".tabbar button.active")?.textContent).toContain("Insights");
  });
});

describe("boot while no Session_Token is held — deferred sign-in", () => {
  beforeEach(() => {
    h.token = null;
  });

  it.each(APP_VIEWS.map((v) => v.path))(
    "opens %s without asking for an email",
    async (path) => {
      bootAt(path);
      if (path === "/app/settings") await screen.findByRole("heading", { name: "Settings" });
      else await shell();

      // The behaviour this change exists to create: an anonymous visitor lands in
      // the app, at the route they asked for, with no sign-in form in the way and
      // no redirect at all. Previously each of these replaced the URL with
      // `/login?next=<path>`.
      expect(url()).toBe(path);
      expect(pushed).toEqual([]);
      expect(replaced).toEqual([]);
      expect(screen.queryByText("Sign in to SnapGut")).toBeNull();
    }
  );

  it("still shows the sign-in screen at the Login_Route", async () => {
    bootAt(LOGIN_PATH);
    await screen.findByText("Sign in to SnapGut");

    // The one path that still means "sign in": someone who navigated here, or who
    // was sent here by signing out, wants the form. No redirect, no entry, URL
    // untouched.
    expect(url()).toBe(LOGIN_PATH);
    expect(pushed).toEqual([]);
    expect(replaced).toEqual([]);
  });

  it("shows the first-run intro before the app, with no account", async () => {
    localStorage.removeItem(ONBOARDED_KEY);
    bootAt(DEFAULT_APP_PATH);

    // The intro used to sit *behind* the sign-in gate, so a new visitor met a
    // six-digit-code form before they were told what the product was. Now the
    // intro is the first thing, and it needs no account.
    await waitFor(() => expect(inTabShell()).toBe(false));
    expect(screen.queryByText("Sign in to SnapGut")).toBeNull();
    expect(url()).toBe(DEFAULT_APP_PATH);
  });
});

describe("switching Addressable_View (Req 4.2)", () => {
  it("adds exactly one history entry", async () => {
    bootAt(DEFAULT_APP_PATH);
    await shell();
    const lengthBefore = window.history.length;

    await click(screen.getByText("Logs"));

    // One entry, at the logs App_Route — not two, and not a replacement.
    expect(url()).toBe("/app/logs");
    expect(pushed).toEqual(["/app/logs"]);
    expect(window.history.length).toBe(lengthBefore + 1);
  });

  it("adds no entry for the view already displayed", async () => {
    bootAt("/app/logs");
    await shell();

    await click(screen.getByText("Logs"));

    expect(url()).toBe("/app/logs");
    expect(pushed).toEqual([]);
  });

  it("adds exactly one entry for settings, which is addressable but internally a flow", async () => {
    bootAt("/app/logs");
    await shell();

    await click(screen.getByLabelText("Settings"));
    await screen.findByRole("heading", { name: "Settings" });

    expect(url()).toBe("/app/settings");
    expect(pushed).toEqual(["/app/settings"]);
  });
});

describe("Ephemeral_Flows and the back gesture (Req 4.6, 4.8)", () => {
  it("activates no Ephemeral_Flow when booting at an App_Route", async () => {
    for (const path of ["/app", "/app/logs", "/app/insights"]) {
      bootAt(path);
      await shell();

      // R4.8 — the tab shell renders only while no flow is open, so its presence
      // is the assertion: nothing was restored without the in-memory data it needs.
      expect(inTabShell()).toBe(true);
      expect(screen.queryByText("How's your gut?")).toBeNull();
      cleanup();
    }
  });

  it("cancels the open flow on a backward navigation and stays in the App_Shell", async () => {
    bootAt(DEFAULT_APP_PATH);
    await shell();

    await click(screen.getByLabelText("Add log"));
    await click(screen.getByText("Symptom"));
    await screen.findByText("How's your gut?");

    // R4.5 — opening the flow pushed one marked entry at the unchanged URL.
    expect(pushed).toEqual([DEFAULT_APP_PATH]);
    expect(window.history.state).toEqual({ flow: true });

    await goBack();

    // R4.6 — the flow's own cancel path ran, the view is back in the shell, and
    // the App_Shell was never left.
    await waitFor(() => expect(screen.queryByText("How's your gut?")).toBeNull());
    expect(inTabShell()).toBe(true);
    expect(isAppPath(window.location.pathname)).toBe(true);
    expect(url()).toBe(DEFAULT_APP_PATH);
    expect(window.history.state).toBeNull();
    // Cancelling added no entry of its own.
    expect(pushed).toEqual([DEFAULT_APP_PATH]);
  });
});
