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
  beforeEach(() => {
    // iOS is the case worth asserting: it is where installing actually protects the
    // data, and where there is no install API so the steps have to be described.
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });
  });

  const NUDGE = "Add SnapGut to your Home Screen";

  it("rides above the nav from the start, with nothing to earn first", async () => {
    // It used to be a modal sheet withheld until a couple of logs had been saved,
    // because interrupting someone with a dialog has to be justified. A bar that sits
    // above the nav does not interrupt, so there is nothing to wait for — and waiting
    // meant most people never met it at all.
    render(<App />);
    await screen.findByLabelText("Add log");
    expect(screen.getByRole("region", { name: NUDGE })).toBeTruthy();
  });

  it("stays put across screens rather than belonging to one tab", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");
    expect(screen.getByRole("region", { name: NUDGE })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Logs"));
    });
    // Mounted by the tab shell, so switching tabs cannot take it away.
    expect(screen.getByRole("region", { name: NUDGE })).toBeTruthy();
  });

  it("offers the manual steps where there is no install API to call", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");

    await act(async () => {
      fireEvent.click(screen.getByText("Add"));
    });
    // A button that silently does nothing would be worse than describing the route.
    expect(screen.getByRole("dialog", { name: NUDGE })).toBeTruthy();
    expect(screen.getByText(/Scroll down and choose/)).toBeTruthy();
  });

  it("takes one dismissal as final and remembers it", async () => {
    render(<App />);
    await screen.findByLabelText("Add log");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dismiss"));
    });
    expect(screen.queryByRole("region", { name: NUDGE })).toBeNull();

    // No snooze to lapse: a nudge that comes back is one people learn to ignore.
    expect(localStorage.getItem("food-snap-install-dismissed")).toBe("1");

    cleanup();
    render(<App />);
    await screen.findByLabelText("Add log");
    expect(screen.queryByRole("region", { name: NUDGE })).toBeNull();
  });

  it("keeps the offer in Settings after the nudge is dismissed", async () => {
    localStorage.setItem("food-snap-install-dismissed", "1");
    render(<App />);
    await screen.findByLabelText("Add log");
    expect(screen.queryByRole("region", { name: NUDGE })).toBeNull();

    // The gear lives in the Logs header, so get there first.
    await act(async () => {
      fireEvent.click(screen.getByText("Logs"));
    });
    await act(async () => {
      fireEvent.click(await screen.findByLabelText("Settings"));
    });
    // Dismissing the nudge answers the nudge, not the question — someone who changes
    // their mind has one place to look.
    expect(await screen.findByText(NUDGE)).toBeTruthy();
  });

  it("stays quiet when already installed", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));

    render(<App />);
    await screen.findByLabelText("Add log");

    // Standalone means the job is done; asking again would be noise.
    expect(screen.queryByRole("region", { name: NUDGE })).toBeNull();
  });
});
