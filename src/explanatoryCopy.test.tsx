// Where the app explains itself, and where it deliberately does not.
//
// Two separate concerns, pinned together because they are the same judgement call.
//
// The Logs timeline carries no standing note: it is a list of what you logged, it
// needs no interpreting, and a permanent explainer above it was the first thing seen
// every single time. Insights is the opposite — it interprets — so that is where the
// medical disclaimer and the counting explanation belong.
//
// The copy assertions exist because this text makes factual claims about what the
// code computes, and those two drift apart silently. An association is a trigger
// *group*, not a food, and the copy said "food" for a long time.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { ONBOARDED_KEY } from "./Intro";

const h = vi.hoisted(() => ({ events: [] as unknown[] }));

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
  getToken: () => null,
  fetchMe: async () => null,
  clearToken: () => {},
}));

import App from "./App";

/** Meals from one trigger group, each followed by the same symptom. */
function seedPattern(n = 6) {
  const day = 86_400_000;
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const t = Date.now() - (i + 1) * day;
    out.push({
      id: `m${i}`,
      type: "meal",
      createdAt: t,
      updatedAt: t,
      dish: "Toast",
      ingredients: [{ name: "wheat bread", confidence: "confident" }],
    });
    out.push({
      id: `s${i}`,
      type: "symptom",
      createdAt: t + 2 * 3_600_000,
      updatedAt: t + 2 * 3_600_000,
      symptoms: [{ id: "bloating", severity: "moderate" }],
    });
  }
  return out;
}

const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

beforeEach(() => {
  h.events = [];
  localStorage.clear();
  localStorage.setItem(ONBOARDED_KEY, "1");
  // Past the install nudge's threshold in some cases, so keep it permanently off:
  // this file is about copy, and a sheet over the content would block the queries.
  localStorage.setItem("food-snap-install-hint-dismissed", "1");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the Logs timeline", () => {
  it("carries no standing explainer above the log", async () => {
    h.events = seedPattern(2);
    window.history.pushState(null, "", "/app/logs");
    render(<App />);
    await screen.findByText("Timeline");

    // The screen is a record, not an assessment, and needed no note to say so.
    expect(screen.queryByText(/Your log stays on this device unless you turn on sync/)).toBeNull();
    expect(screen.queryByText("Where your log lives")).toBeNull();
  });

  it("still warns about backups when one is actually due", async () => {
    h.events = seedPattern(2);
    window.history.pushState(null, "", "/app/logs");
    render(<App />);
    await screen.findByText("Timeline");

    // Removing the permanent note must not remove the warning that has a reason to
    // appear — this is the part that protects a device-only log.
    expect(screen.getByText(/Back it up so you don't lose it/)).toBeTruthy();
  });
});

describe("the Insights explanations", () => {
  beforeEach(() => {
    h.events = seedPattern();
    window.history.pushState(null, "", "/app/insights");
  });

  it("keeps the medical disclaimer on the interpreting surface", async () => {
    render(<App />);
    // `InfoNote` shows a one-line notice and puts the detail behind a help control,
    // labelled "<title> — <hint>".
    await click(await screen.findByLabelText(/^How to read these patterns —/));

    // The app's one medical disclaimer now lives here, on the screen that draws
    // conclusions rather than the one that lists entries. It must not be lost.
    const text = document.body.textContent ?? "";
    expect(text).toContain("not a medical device");
    expect(text).toContain("does not diagnose");
    expect(text).toMatch(/not an allergy or intolerance test/);
  });

  it("describes an association as a group of foods, not a single food", async () => {
    render(<App />);
    await screen.findByText("Possible associations");
    await click(screen.getByLabelText(/^What the numbers mean —/));

    // `insights.ts` keys associations by TriggerGroup and divides by meals containing
    // the group, so calling it a "food" — as this copy did — misdescribed the number
    // directly under it.
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/group of foods/i);
    expect(text).toMatch(/meals containing that group were\s+followed by that symptom/);
    expect(text).toMatch(/at least twice/);
  });

  it("admits the grouping can be wrong", async () => {
    render(<App />);
    await screen.findByText("Possible associations");
    await click(screen.getByLabelText(/^What the numbers mean —/));

    // Name matching puts "almond milk" in lactose. A screen that explains a mechanism
    // confidently has to say where the inputs are soft.
    expect(document.body.textContent).toMatch(/almond milk/i);
  });

  it("explains why a daily staple can stay unranked", async () => {
    render(<App />);
    await click(await screen.findByText("Foods"));
    await click(await screen.findByLabelText(/^How foods get ranked —/));

    // `MIN_OTHER_MEALS` holds a food back until there are meals without it to compare
    // against. Unexplained, that reads as the ranking being broken.
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/almost every meal may stay unranked/i);
    expect(text).toMatch(/without/i);
  });

  it("states the ranking window the code actually uses", async () => {
    render(<App />);
    await click(await screen.findByText("Foods"));

    // `foodScores.ts` uses a flat 24 hours, separate from the Patterns lag window.
    // Two windows in one product is a real drift risk.
    expect(document.body.textContent).toMatch(/within 24h/);
  });
});
