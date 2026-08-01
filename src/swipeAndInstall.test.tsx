// Swipe navigation and the install nudge.
//
// The swipe tests are mostly about restraint. The app is full of controls a
// horizontal drag already means something to — the `.hscroll` chip rows in the When
// picker and the Foods list especially — and a page-turn gesture that steals from any
// of them trades a nicety for a broken control. So the interesting assertions are the
// gestures that must be *ignored*.
//
// The install nudge is tested for when it appears rather than how it looks: asking
// before the user has anything worth protecting is how a prompt teaches people to
// dismiss prompts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { ONBOARDED_KEY } from "./Intro";
import { DEFAULT_APP_PATH } from "../shared/site.js";

const h = vi.hoisted(() => ({
  token: null as string | null,
  events: [] as unknown[],
}));

vi.mock("./db", async (o) => ({
  ...(await o<typeof import("./db")>()),
  getEvents: async () => h.events,
  putEvent: async () => {},
  deleteEvent: async () => {},
  getOutboxCount: async () => 0,
  sweepTombstones: async () => 0,
  getMeta: async () => undefined,
  setMeta: async () => {},
}));
vi.mock("./cloudSync", async (o) => ({
  ...(await o<typeof import("./cloudSync")>()),
  hydrateSyncState: async () => {},
  requestSync: async () => {},
  startTriggers: () => () => {},
}));
vi.mock("./session", async (o) => ({
  ...(await o<typeof import("./session")>()),
  getToken: () => h.token,
  fetchMe: async () => null,
  clearToken: () => {},
}));

import App from "./App";

/** A synthetic swipe on the document, as the hook listens for it. */
async function swipe(
  from: { x: number; y: number },
  to: { x: number; y: number },
  target: Element = document.body,
  durationMs = 100
) {
  const touch = (x: number, y: number) => [{ clientX: x, clientY: y }];
  await act(async () => {
    fireEvent.touchStart(target, { touches: touch(from.x, from.y) });
    fireEvent.touchMove(target, { touches: touch(to.x, to.y) });
    vi.setSystemTime(Date.now() + durationMs);
    fireEvent.touchEnd(target, { changedTouches: touch(to.x, to.y) });
  });
}

const activeTab = () =>
  document.querySelector(".tabbar button.active")?.textContent?.trim() ?? "camera";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.token = null;
  h.events = [];
  localStorage.clear();
  localStorage.setItem(ONBOARDED_KEY, "1");
  window.history.pushState(null, "", DEFAULT_APP_PATH);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("swiping between views", () => {
  it("moves from the camera to insights on a left swipe", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");

    await swipe({ x: 300, y: 300 }, { x: 100, y: 305 });

    // Dragging left reveals what is to the right, like a carousel.
    expect(activeTab()).toContain("Insights");
    expect(window.location.pathname).toBe("/app/insights");
  });

  it("moves from the camera to logs on a right swipe", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");

    await swipe({ x: 100, y: 300 }, { x: 300, y: 300 });

    expect(activeTab()).toContain("Logs");
    expect(window.location.pathname).toBe("/app/logs");
  });

  it("stops at the ends rather than wrapping", async () => {
    window.history.pushState(null, "", "/app/insights");
    render(<App />);
    await screen.findByLabelText("Add log");

    await swipe({ x: 300, y: 300 }, { x: 100, y: 300 });

    // Wrapping would loop a user back where they started, which reads as a bug.
    expect(window.location.pathname).toBe("/app/insights");
  });

  it("ignores a mostly-vertical drag", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");

    // An imprecise scroll. Treating this as a page change is the single most
    // irritating way to get swipe navigation wrong.
    await swipe({ x: 300, y: 300 }, { x: 220, y: 100 });

    expect(window.location.pathname).toBe(DEFAULT_APP_PATH);
  });

  it("ignores a drag too short to be deliberate", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");

    await swipe({ x: 300, y: 300 }, { x: 265, y: 300 });

    expect(window.location.pathname).toBe(DEFAULT_APP_PATH);
  });

  it("ignores a slow drag, which is a selection rather than a flick", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");

    await swipe({ x: 300, y: 300 }, { x: 100, y: 300 }, document.body, 900);

    expect(window.location.pathname).toBe(DEFAULT_APP_PATH);
  });

  it("ignores a two-finger gesture", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");

    await act(async () => {
      fireEvent.touchStart(document.body, {
        touches: [
          { clientX: 300, clientY: 300 },
          { clientX: 320, clientY: 320 },
        ],
      });
      fireEvent.touchEnd(document.body, {
        changedTouches: [{ clientX: 100, clientY: 300 }],
      });
    });

    // A pinch or a zoom, never a page change.
    expect(window.location.pathname).toBe(DEFAULT_APP_PATH);
  });

  it("leaves a horizontal chip row to scroll itself", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    // Open a log flow, which is where `.hscroll` rows live.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add log"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Symptom"));
    });
    const row = document.querySelector(".hscroll");
    expect(row).toBeTruthy();

    await swipe({ x: 300, y: 500 }, { x: 100, y: 500 }, row!);

    // Two reasons this must not navigate: the gesture belongs to the chip row, and a
    // flow is open — swiping the page out from under an unsaved form would lose it.
    expect(screen.getByText("When?")).toBeTruthy();
  });

  it("is inert while a flow is open, wherever the touch lands", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add log"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Bowel movement"));
    });

    await swipe({ x: 300, y: 200 }, { x: 100, y: 200 });

    expect(screen.getByText("Bowel movement")).toBeTruthy();
  });

  it("ignores a drag that starts in a text field", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add log"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Symptom"));
    });
    const input = document.querySelector("input.search, textarea");
    expect(input).toBeTruthy();

    await swipe({ x: 300, y: 400 }, { x: 100, y: 400 }, input!);

    // Selecting text inside a field is a horizontal drag too.
    expect(screen.getByText("When?")).toBeTruthy();
  });
});

describe("the install nudge", () => {
  /** Enough saved logs to have something worth protecting. */
  function withLogs(n: number) {
    h.events = Array.from({ length: n }, (_, i) => ({
      id: `e${i}`,
      type: "symptom",
      createdAt: Date.now() - i * 1000,
      updatedAt: Date.now() - i * 1000,
      symptoms: [],
    }));
  }

  beforeEach(() => {
    // The nudge only offers manual steps on iOS, and only a button where the browser
    // has given us a real install prompt to fire. iOS is the case worth asserting,
    // because it is where installing actually protects the data.
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });
  });

  it("stays quiet before the user has logged anything", async () => {
    withLogs(0);
    render(<App />);
    await screen.findByLabelText("Add log");

    // Asking a visitor who has logged nothing is how a prompt gets trained away.
    expect(screen.queryByText("Keep your log safe")).toBeNull();
  });

  it("stays quiet after a single log", async () => {
    withLogs(1);
    render(<App />);
    await screen.findByLabelText("Add log");

    expect(screen.queryByText("Keep your log safe")).toBeNull();
  });

  it("appears once the habit has started", async () => {
    withLogs(2);
    render(<App />);

    // The reason it matters on iOS specifically: an uninstalled PWA's storage can be
    // cleared after a week of not visiting, which would take the log with it.
    await screen.findByText("Keep your log safe");
    expect(screen.getByText("Add to Home Screen")).toBeTruthy();
  });

  it("snoozes on 'Not now' rather than disappearing forever", async () => {
    withLogs(3);
    render(<App />);
    await screen.findByText("Keep your log safe");

    await act(async () => {
      fireEvent.click(screen.getByText("Not now"));
    });
    expect(screen.queryByText("Keep your log safe")).toBeNull();

    // Remounting inside the snooze window stays quiet.
    cleanup();
    render(<App />);
    await screen.findByLabelText("Add log");
    expect(screen.queryByText("Keep your log safe")).toBeNull();

    // A snooze is a timestamp, not a permanent flag — so it can lapse.
    expect(localStorage.getItem("food-snap-install-snoozed-at")).toBeTruthy();
    expect(localStorage.getItem("food-snap-install-hint-dismissed")).toBeNull();
  });

  it("returns after the snooze lapses", async () => {
    withLogs(3);
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem("food-snap-install-snoozed-at", String(eightDaysAgo));

    render(<App />);
    await screen.findByText("Keep your log safe");
  });

  it("stays gone after 'Don't ask again'", async () => {
    withLogs(3);
    render(<App />);
    await screen.findByText("Keep your log safe");

    await act(async () => {
      fireEvent.click(screen.getByText("Don't ask again"));
    });

    cleanup();
    render(<App />);
    await screen.findByLabelText("Add log");
    expect(screen.queryByText("Keep your log safe")).toBeNull();
  });

  it("stays quiet when already installed", async () => {
    withLogs(5);
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));

    render(<App />);
    await screen.findByLabelText("Add log");

    // Standalone means the job is done; asking again would be noise.
    expect(screen.queryByText("Keep your log safe")).toBeNull();
  });
});
